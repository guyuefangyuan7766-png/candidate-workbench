# 第三方依赖说明

本项目自身采用 MIT License。以下为 `package-lock.json` 当前锁定的直接依赖；它们均允许自托管和二次开发，但仍须遵守各许可证文本。

## 运行依赖

| 包 | 锁定版本 | 许可证 |
| --- | ---: | --- |
| exceljs | 4.4.0 | MIT |
| express | 5.2.1 | MIT |
| lucide-react | 0.468.0 | ISC |
| mammoth | 1.12.0 | BSD-2-Clause |
| multer | 2.2.0 | MIT |
| pdfjs-dist | 6.2.108 | Apache-2.0 |
| react | 19.2.8 | MIT |
| react-dom | 19.2.8 | MIT |
| react-markdown | 10.1.0 | MIT |
| remark-gfm | 4.0.1 | MIT |
| xls-reader | 0.7.0 | MIT |

## 开发依赖

| 包 | 锁定版本 | 许可证 |
| --- | ---: | --- |
| @types/react | 19.2.18 | MIT |
| @types/react-dom | 19.2.4 | MIT |
| @vitejs/plugin-react | 5.2.0 | MIT |
| typescript | 5.9.3 | Apache-2.0 |
| vite | 7.3.6 | MIT |

`xls-reader` 用于在服务端只读解析未加密 Excel 97-2003 BIFF8 `.xls`，当前精确锁定为 `0.7.0` 且没有运行时依赖。匿名 `.xls` 自动化测试样本来自该包的 MIT 许可样本集合。

`pdfjs-dist@6.2.108` 来自 Mozilla 的官方 [pdf.js](https://github.com/mozilla/pdf.js) 仓库，采用 Apache-2.0；用于本地提取文本型 PDF。2026-08-05 通过 GitHub 仓库元数据、安全公告端点和 npm registry 交叉核验：官方仓库未归档且仍活跃，npm 包指向同一仓库并声明 Apache-2.0。GitHub Advisory `GHSA-hq66-cqwq-w95j` 影响 5.6.83 起的未修复版本，公告指定 6.2.108 为修复版本；更早的 `GHSA-wgrm-67xf-hhpq` 已在 4.2.67 修复。应用仍显式关闭 PDF scripting/eval 和远程 fetch，并在独立 worker 中设置解析超时，不能只依赖版本修复。

`mammoth@1.12.0` 来自官方 [mammoth.js](https://github.com/mwilliamson/mammoth.js) 仓库，采用 BSD-2-Clause；用于本地提取 DOCX 原始文本。2026-08-05 通过 GitHub 仓库元数据、安全公告端点和 npm registry 交叉核验：官方仓库未归档且仍活跃，npm 包指向同一仓库并声明 BSD-2-Clause，官方仓库的 GitHub published advisories 为空。应用使用 `externalFileAccess:false`，不访问文档外部文件，并在独立 worker 中限制解析时间。

两项解析依赖均不连接外部解析服务、不执行 Office 宏、不要求 LibreOffice、Java、Python、GPU 或 OCR 运行时。PDF、DOCX 和其他附件内容仍是不可信输入，许可证和 advisory 核验不能替代文件签名、容器限制、隔离存储和资源上限。

`react-markdown@10.1.0` 与 `remark-gfm@4.0.1` 均来自 unified/remark 生态并采用 MIT License，用于将 Agent 回复渲染为 React 元素并支持 GFM 表格等语法。应用未启用 `rehype-raw`，不使用 HTML 字符串注入；链接协议由本地白名单再次校验，Markdown 图片不会触发远程资源加载。

传递依赖及精确版本以 `package-lock.json` 为准。重新分发软件时应保留项目和依赖包中的许可证文件；升级或新增依赖前必须重新执行许可证、签名、来源证明和漏洞复核。

模型网关、模型权重和公司内部 Agent key 不属于本仓库许可证范围。是否可以离线部署或商业使用取决于实际选择的模型和网关条款，不能由本项目的 MIT License 代替确认。
