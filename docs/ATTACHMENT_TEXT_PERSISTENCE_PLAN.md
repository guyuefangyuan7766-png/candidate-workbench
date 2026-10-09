# 附件文本持久化方案（v1）

日期：2026-10-07。状态：**已获批准，待实施**。
预算：**¥0（纯本地，无模型调用）**；预计耗时 **约 3 小时**；磁盘增量约 0.2–0.4 GiB。

## 一、目标

把已确认有文本的 69,491 份原始简历附件重新提取纯文本，写回
`candidate_attachments.extracted_text`，让简历原文进入既有检索索引链，
并为后续向量管道提供数据源。

**不做的事**：

- 不重跑模型解析（阶段 3 已完成：541,257 行 / 69,491 人，不再花钱）
- 不处理 `no_content`（27,299 份，正文 <40 字）与 `failed`（1,543 份，扫描件无文本层）
- 不处理 `standard.pdf`（与原件内容重复，v2 再评估）
- **不直接写** `candidate_resume_documents`；但写 `candidate_attachments` 会**由触发器自动**写入该表（见下节订正），这一步无法关闭，也**不需要**关闭

## 一之二、触发器自动写入说明（2026-10-07 实测订正）

原文曾写「不写 `candidate_resume_documents`」。实测该表**无法避免被写**：

`candidate_attachments_resume_au` 触发器对**任意** `attachment_type` 生效，只要更新后满足
`parse_status='parsed' AND extracted_text<>''`，就自动插入一行 `attachment:<附件ID>`：

```sql
CREATE TRIGGER candidate_attachments_resume_au
    AFTER UPDATE ON candidate_attachments BEGIN
      DELETE FROM candidate_resume_documents WHERE document_id = 'attachment:' || OLD.id;
      INSERT INTO candidate_resume_documents(...)
      SELECT 'attachment:' || NEW.id, NEW.candidate_id, 'attachment', NEW.id,
             NEW.original_filename, NEW.extracted_text, ...
      WHERE NEW.parse_status = 'parsed' AND NEW.extracted_text <> '';
    END
```

一次 UPDATE 会同时引发两条独立链路：

```text
UPDATE candidate_attachments
├─(candidate_attachments_resume_au)─→ candidate_resume_documents ─(candidate_resume_documents_ai)─→ candidate_resume_fts
└─(search_v2_candidate_attachments_au)─→ search_index_dirty_v2 ─→ business-search-worker ─→ search_documents_v2 + FTS
```

三点结论：

1. **这是向量化的前提**：向量维护以 `candidate_resume_documents` 为修订骨架（`readSearchDocumentRevisions()`），附件不进这张表就永远不会被向量化。
2. **它让本方案第四节的回滚 SQL 自动生效**：`parse_status` 回退为 `pending` 会走「DELETE 后不 INSERT」分支，文档行、FTS 行与向量索引随之消失。
3. **副作用**：修订扫描量增加。`candidate_resume_documents` 从 1,488,116 行增至约 1,557,607 行（+69,491），单轮维护的前置扫描成本约增加 1.2 秒【估算｜按旧项目 455,744 行 7.8 秒线性外推】。

## 二、现状依据（2026-10-07 实测）

| 项 | 数值 |
| --- | --- |
| `candidate_attachments` 行数 | 260,138（origin 108,974 / standard 118,906 / avatar 32,258） |
| `extracted_text` 非空行数 | **0**（从未落库） |
| 解析状态 | parsed 69,491 / no_content 27,299 / failed 1,543 |
| 提取吞吐实测 | 60 份随机样本、并发 6 → **148 ms/份**（p50 146ms，p95 2.2s），外推 69,491 份 ≈ **2.9 小时** |
| 提取器 | `scripts/extract-origin-text.mjs <storagePath> <mimeType>`（独立子进程，120s 超时，windowsHide） |
| 索引链路 | `candidate_attachments` 的 AI/AU/AD 触发器 → `search_index_dirty_v2` → `server/business-search-worker.js` → `search_documents_v2` + FTS（当前 candidate_attachments 已占 2,081,104 行，文本为空） |

## 三、实施步骤

### 1. 新增脚本 `scripts/persist-attachment-text.mjs`

- 选行：`candidate_resume_parse_state.outcome='parsed'` JOIN 对应 `resume_origin` 附件，
  排除已持久化行（`extracted_text <> ''` 或 `parser_version='origin-text-v1'`）
- 逐份调 `extract-origin-text.mjs`（并发 6，`windowsHide: true`，单份 120s 超时）
- 文本长度 ≥40 才写库：`extracted_text` + `parse_status='parsed'` +
  `parser_version='origin-text-v1'` + `source='origin_text_persist'` + `updated_at`
- 失败/空文本不落库，追加 `data/persist-attachment-text-failed.jsonl`
  （candidate_id / attachment_id / error / at）
- 每 200 份一个 `BEGIN IMMEDIATE` 事务；`SQLITE_BUSY` 退避重试 5 次
- 进度文件 `data/persist-attachment-text-progress.json`（每 500 份刷新，可断点续跑）
- CLI：`--limit N` / `--apply`（默认 dry-run）/ `--concurrency 6` / `--report`

### 2. 灰度与全量

1. `--limit 200`（dry-run）核对选行数与样本质量
2. `--limit 2000 --apply` 写库并校验（计数、抽样、幂等）
3. 全量后台运行（日志 + 进度文件），约 3 小时

### 3. 刷新检索索引

持久化**写库期间停应用服务**（项目规则：不与写库并行）；完成后启动服务，
由 `business-search-worker.js` 把 `search_index_dirty_v2` 刷空，
附件的 `extracted_text` 即进入 `search_documents_v2` 与 FTS。

### 4. 验收

- [ ] `SELECT COUNT(*) FROM candidate_attachments WHERE source='origin_text_persist' AND parse_status='parsed' AND extracted_text<>''` ≥ 69,000（允许抽样失败）
- [ ] `SELECT count(*) FROM candidate_resume_documents WHERE source_type='attachment'` ≈ 落库份数（今日基线 **0**，新增由触发器自动完成）
- [ ] `candidate_resume_documents` 总行数从 1,488,116 增至约 **1,557,607**（+69,491），`candidate_resume_fts` 同步增加
- [ ] 随机抽 20 份比对原文（字符数、关键片段可读）
- [ ] 随机 5 条关键词 `MATCH` 命中附件原文（走 `search_documents_v2_fts`）
- [ ] 重跑脚本第二次 0 变更（幂等）
- [ ] 主库体积增量 0.2–0.4 GiB

### 5. 回滚

- 实施前导出目标 id 清单到 `data/persist-attachment-text-ids.json`
- 回滚 SQL（仅限本次写入的行）：
  `UPDATE candidate_attachments SET extracted_text='', parse_status='pending', parser_version='', source='' WHERE source='origin_text_persist'`
- 回滚后触发 dirty 队列重建索引即恢复原状

## 四、安全约束

- 只写 `candidate_attachments` 的 `extracted_text / parse_status / parser_version / source / updated_at` 五列
- 不碰 `candidates`、`candidate_profile_sections`、`candidate_resume_documents`
- 不跑 `scripts/import-talent-asset.mjs --reset`；不删除、不移动 47 GB 原件
- 子进程一律 `windowsHide: true`；不弹命令行窗口
- 涉及真实候选人数据：全程本地处理，**不发送任何模型请求**

## 五、后续（Phase B，另行批准）

产出 `docs/VECTOR_HYBRID_PLAN.md`（参考 C 盘旧项目，含成本门禁：
embedding 单价未经计费探针实测前禁止全量向量化）。

## 六、实施结果（2026-10-07）

**结论：完成，落库 69,491 / 69,491（100%），无剩余失败。**

| 项 | 结果 |
| --- | --- |
| 落库计数 | 69,491（avg 2,018 字符/份） |
| 触发器自动写入 | `candidate_resume_documents` attachment 69,491 行（总行数 1,488,116 → **1,557,607**）；`candidate_resume_fts` 同步 1,557,607 |
| 其他表 | 未变：candidates 118,918 / candidate_profile_sections 1,369,205 / candidate_attachments 260,138 |
| 检索索引 | `search_documents_v2` **25,270,021** 文档（附件类 2,157,871），dirty=0，checkpoint **ready**，字段覆盖 **140/140** |
| FTS 抽验 | 猎聘 3,524 / 实习僧 933 / Unity 4,165（均命中 `candidate_attachments.extracted_text`） |
| 耗时 | 灰度 2,000 份 3.5 分钟；全量 67,502 份 **141.6 分钟**；重试三轮 5.4 / 0.9 / 0.07 分钟 |
| 服务状态 | 验收期间停服；结束时服务保持停止（与开始前一致） |

**验收四项**

1. 落库计数 69,491 ≥ 69,000 ✅
2. 随机 20 份重抽取比对：20/20 逐字节一致 ✅
3. 5 个关键词 `search_documents_v2_fts` MATCH 命中附件原文 ✅
4. 重跑幂等：第二次运行后剩余可选 0、已落库行状态异常 0 ✅

### 发现 1（重要）：`0xC0000005` 是偶发崩溃，不是文件损坏

首轮 822 份 PDF 报 `exit:3221225477` 失败；**重试后 732 → 88 → 2 → 0 全部成功**。
因此失败清单只代表「本轮未成功」，重复运行 `--apply` 即可继续收敛，不要按不可恢复处理。
（推测与 PDF worker 的原生内存压力有关，未定位到具体触发条件，属【待实测】。）

### 发现 2（重要）：business-search worker 的收敛缺陷

实测两次出现：dirty 队列清零后 checkpoint 停留在 `indexing`，worker 下一次运行把
它当作「回填被中断」，于是**重新排队整库约 190 万行**并再次消费——形成约 50 分钟一轮的循环，
期间 `isBusinessSearchReady()` 恒为 false（全字段搜索不可用）。
成因：能把状态写回 `ready` 的全字段覆盖率扫描只在 `backfillBusinessSearch()` 末尾执行，
而该路径在重新排队之后才跑，扫描时队列已非空 → 结果恒为 `pending`。

本次处置：停服后用服务自己的 `flushBusinessSearchDirty()` + `getBusinessSearchCoverage()`
（均来自 `server/business-search.js`）刷干队列并重算覆盖率，checkpoint 回到 `ready`（140/140）。
**建议单独开一个任务修 worker 的收敛逻辑**；向量维护是独立调度（`search-vector-maintenance-service.js`），不受此缺陷影响。
