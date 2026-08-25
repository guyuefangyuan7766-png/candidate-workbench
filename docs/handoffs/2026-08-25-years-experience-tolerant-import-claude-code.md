# Claude Code 交接单：工作年限宽容导入

## 交接目标

请在 `C:\Users\cboy\Documents\北森` 实施“工作年限宽容导入与原文展示”。用户要求是：

- 不要把无法识别的工作年限按 `0` 处理。
- 对来源格式绝对宽容，按照原字段展示。
- 用户可见路径不要出现字面量 `null`；来源为空时显示空白，来源非空时显示原文。
- 能安全解析的值仍保留数值能力，供排序/筛选使用。

本交接单只授权代码实现和测试，不授权修改正式数据库、覆盖原始 Excel 或清理工作区中与本功能无关的未提交改动。

## 先读文档

按顺序阅读：

1. `docs/superpowers/specs/2026-08-25-years-experience-tolerant-import-design.md`
2. `docs/superpowers/plans/2026-08-25-years-experience-tolerant-import.md`
3. `docs/DATA_MODEL.md`
4. `docs/IMPORT_GUIDE.md`
5. `docs/FIELD_MAPPING.md`

实施顺序、测试先行要求和验收样例以规格/计划为准；本交接单是执行摘要。

## 当前根因

目前代码把 `years_experience` 当作纯数字：

- `server/validation.js:198` 附近的 `normalizeYears()` 只取第一个阿拉伯数字。
- `server/validation.js:346-350` 附近在解析失败时给整行增加工作年限错误。
- `server/database.js:965` 和 `src/api.ts:975` 将缺失数值默认成 `0` 或强制 `Number()`，导致原文丢失。
- `src/components/CandidateDrawer.tsx:237`、`src/components/PipelineBoard.tsx:80` 只按数字展示。
- `src/components/CandidateForm.tsx:69` 当前使用 `type="number"`，无法回填 `3年6个月`、`应届` 等文本。
- `server/attachments.js:1241` 及 `src/attachment-candidate-prefill.ts:129-148` 另有窄正则和 `0` 默认值，必须同步。

## 必须落地的契约

### 数据库

保留既有：

```text
candidates.years_experience REAL
```

新增：

```text
candidates.years_experience_raw TEXT NOT NULL DEFAULT ''
```

新增 V13 幂等迁移记录：

```text
(13, 'candidate_years_experience_raw')
```

不要把旧数值列改成 TEXT，也不要重建候选人表。旧记录只有数字时可以回填对应数字文本；旧 `NULL` 必须保持为空，不得回填 `0`。

### 统一解析接口

在 `server/validation.js` 提供并导出：

```js
normalizeYearsExperience(value) -> {
  raw: string,
  numeric: number | null,
  provided: boolean
}

formatYearsExperience({ raw, numeric }) -> string
```

要求：

- `3`、`3.5`、`3年`、`3 年`、`3 years`、`3 yrs`、`3年6个月`、`42个月`、`三年`、`三年半` 通过；可明确计算的值生成数值投影。
- `应届`、`无经验`、`经验不详`、`待核实`、`1-3年`、`1至3年`、`约3年`、`3年以上` 通过但只保留原文，数值投影为 `null`。
- `100年` 不得因超过旧的 80 年上限而失败或变成 0；可作为有限非负数保存。
- `-1年`、`Infinity`、超出有限数范围的值通过并保留原文，数值投影为 `null`。
- 空值返回 `{ raw: '', numeric: null, provided: false }`。
- 任何非空值都不能单独产生 validation error。

`sanitizeCandidateInput()` 必须把结果写成 `years_experience` + `years_experience_raw`。不要让普通调用方单独伪造 `years_experience_raw` 绕过统一校验。
序列化和导出都复用 `formatYearsExperience`：原文非空优先，数值次之，完全缺失返回空字符串。

### API/UI/导出

候选人响应增加：

```json
{
  "years_experience": 3.5,
  "years_experience_raw": "3年6个月",
  "years_experience_display": "3年6个月"
}
```

缺失数值在 API 内可以是 JSON `null`，但用户可见的 `years_experience_display` 必须始终是字符串：原文优先，数字次之，无值为 `""`。不得再使用 `Number(value ?? 0)`。

- 表单工作年限改为可输入文本并优先回填原文。
- 档案抽屉、看板、导入预览显示原文；明确输入 `0` 时必须显示 `0`。
- 数值排序/筛选继续读 `years_experience`，空值不隐式参加 `>=`/`<=` 判断。
- 导出的现有“工作年限”列优先写原文；没有原文时写格式化数字；不得输出 `null`。

## 代码修改清单

按计划逐项检查，不要遗漏第二入口：

1. `server/validation.js`：解析函数、sanitize、长度/错误语义。
2. `server/database.js`：基础列、V13 迁移、序列化。
3. `server/constants.js`、`server/candidates.js`、`server/app.js`：字段白名单、插入/更新/API。
4. `server/beisen-import.js`、`server/import-export.js`：北森/通用导入和导出。
5. `server/attachments.js`、`src/attachment-candidate-prefill.ts`：附件文本/视觉建议和预填充。
6. `src/api.ts`、`src/types.ts`：null-preserving 类型和兼容归一化。
7. `src/components/CandidateForm.tsx`、`CandidateDrawer.tsx`、`PipelineBoard.tsx`：原文编辑/显示。
8. `docs/DATA_MODEL.md`、`docs/API.md`、`docs/FIELD_MAPPING.md`、`docs/IMPORT_GUIDE.md`、`docs/TESTING.md`、`docs/OPERATIONS.md`、`docs/DECISIONS.md`、`docs/ITERATION_LOG.md`、`CHANGELOG.md`、`README.md`：实施后同步 V13 文档。

不要为本功能重写职位关系、人才库关系、来源历史或入职字段逻辑；那些字段已有独立语义。手机号/邮箱冲突仍必须失败，不能因为工作年限宽容而放行。

## 强制测试顺序

先写失败测试，再实现生产代码。至少新增 `tests/backend/years-experience-import.test.mjs`，覆盖：

- 解析矩阵：`3`、`3.5`、`3年`、`3 年`、`3 yrs`、`3年6个月`、`42个月`、`三年半`、`约3年`、`1-3年`、`1至3年`、`应届`、`经验不详`、`100年`、`-1年`、空值。
- 无法解析的非空工作年限不再导致导入行失败。
- 原文贯穿预览、API、详情和导出。
- 明确 `0` 保持 0；缺失不变成 0 或可见 `null`。
- V13 迁移幂等，旧数据不丢。
- 手机/邮箱冲突仍失败。
- 附件解析/预填充不再把缺失默认成 0。

聚焦命令：

```powershell
node --test tests/backend/years-experience-import.test.mjs tests/backend/xls-import.test.mjs tests/backend/attachment-semantic-parsing.test.mjs tests/backend/attachment-candidate-prefill.test.mjs tests/backend/candidate-demographics-ui.test.mjs
npx tsc --noEmit
npm run build
```

完成前运行：

```powershell
npm test
git diff --check
```

若遇到与本功能无关的既有失败，保留失败原貌并在交接结果中列出测试名，不得通过放宽新断言来“修绿”。

## 真实样本核验

实现通过后，对以下文件只读预览，最多取 100 条：

```text
C:\Users\cboy\Desktop\人才库简历\自定义excel7-20caac42-246c-402c-a583-45e991ec30b3.xls
```

核验要求：

- 不改扩展名、不覆盖源文件、不写正式数据库。
- 记录总行数、有效行数、仅因工作年限失败的行数、其他错误数、原文值数量、数值投影数量、身份冲突数量，以及关联职位匹配/新建、人才库关系和来源历史的聚合数。
- 证明非标准工作年限不再生成 `years_experience` 错误；若有手机号/邮箱冲突，仍显示冲突。
- 证明“最后职位类投递的职位id”仍是关联职位键；人才库和来源字段仍分别写入既有关系/历史路径，不把入职职位误当关联职位。
- 只把脱敏聚合写入 `docs/evidence/v13-years-experience-import-20260825.json`，禁止写姓名、手机、邮箱、候选人 ID、原始 payload 或预览 token。

## 不可违反的事项

- 非空来源值不按 0 处理；用户可见展示不显示 `null`，而是展示原始信息或空白。
- 不准把非空无法解析值写成 0。
- 不准为了让类型通过，把空值在前端/API 默认成 0。
- 不准把 `years_experience` 直接改成字符串而删除数值筛选能力。
- 不准把 `入职职位`、职位编号、手机号或其他列当作工作年限来源。
- 不准修改正式数据库、用户原始 `.xls`、已有职位诊断输出或工作区中无关的用户改动。
- 不准在公开日志/证据中输出候选人敏感信息。

## 交付回报格式

完成后请回报：

1. 实际修改文件和 V13 迁移名称。
2. 解析矩阵中每类值的实际结果，特别是 `0`、未知文本和范围值。
3. 聚焦测试、全量测试、TypeScript、构建和 `git diff --check` 的命令与结果。
4. 100 行只读预览的脱敏聚合结果和证据文件路径。
5. 未完成的检查、已知兼容风险和回滚方式。
