import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const drawer = readFileSync(new URL('../../src/components/CandidateDrawer.tsx', import.meta.url), 'utf8')
const preview = readFileSync(new URL('../../src/components/ResumePreviewPane.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../../src/workspace.css', import.meta.url), 'utf8')

test('attachment resume is its own tab placed before the profile tab', () => {
  // 类型里 attachment 在最前
  assert.match(drawer, /export type DetailTab = "attachment" \| "profile" \|/)
  // 默认落在附件简历页签
  assert.match(drawer, /initialTab = "attachment"/)
  // 按钮顺序：附件简历 在 档案 之前
  const attachmentIndex = drawer.indexOf('附件简历\n')
  const profileIndex = drawer.indexOf('>\n                档案\n')
  assert.ok(attachmentIndex > 0, '找不到「附件简历」页签按钮')
  assert.ok(profileIndex > 0, '找不到「档案」页签按钮')
  assert.ok(attachmentIndex < profileIndex, '「附件简历」必须排在「档案」之前')
})

test('resume preview renders only inside the attachment tab instead of the permanent left pane', () => {
  assert.match(drawer, /tab === "attachment" && \(\s*<ResumePreviewPane/)
  assert.match(drawer, /tab !== "attachment" && \(\s*<div className="tw-detail-content">/)
  assert.match(drawer, /tw-drawer-body\$\{tab === "attachment" \? " tw-drawer-body-attachment" : ""\}/)
  // 详情抽屉宽度对所有候选人一致：不再随"有没有简历附件"变化
  assert.match(drawer, /className=\{`tw-drawer\$\{mode === "detail" \? " tw-drawer-detail" : " tw-drawer-wide"\}`\}/)
  assert.match(styles, /\.tw-drawer-detail \{ --tw-drawer: min\(1000px, 90vw\); \}/)
  assert.doesNotMatch(drawer, /tw-drawer-resume/)
  // 旧的常驻左右两栏布局必须彻底移除
  assert.doesNotMatch(drawer, /tw-drawer-body-split/)
  assert.doesNotMatch(styles, /\.tw-drawer-body-split\s*\{/)
})

test('resume preview exposes a persistent frameless toggle and fills the tab', () => {
  assert.match(preview, /const FRAMELESS_KEY = "tw-resume-frameless"/)
  assert.match(preview, /window\.localStorage\.getItem\(FRAMELESS_KEY\)/)
  assert.match(preview, /window\.localStorage\.setItem\(FRAMELESS_KEY/)
  assert.match(preview, /title=\{frameless \? "显示边框" : "隐藏边框（铺满显示）"\}/)
  assert.match(preview, /className=\{`tw-resume-pane\$\{frameless \? " is-frameless" : ""\}`\}/)
  // 简历保持原始比例（不强制适应宽度）；隐藏边框时只关掉浏览器自带工具条与缩略图栏
  assert.match(preview, /function frameUrl\(attachmentId: string, frameless: boolean\)/)
  assert.match(preview, /`\$\{base\}#toolbar=0&navpanes=0`/)
  assert.doesNotMatch(preview, /view=FitH/)
  assert.match(preview, /src=\{frameUrl\(current\.id, frameless\)\}/)
  // 只改 URL 片段不会重载 iframe，必须靠 key 重挂载才能让 PDF 查看器收起工具条
  assert.match(preview, /key=\{frameless \? "frameless" : "framed"\}/)
  // 无论一个还是两个版本，工具条结构一致
  assert.doesNotMatch(preview, /resumes\.length > 1 \?/)
  assert.match(styles, /\.tw-resume-pane\.is-frameless \.tw-resume-frame\s*\{[^}]*border: 0;/)
  // 预览框贴合 A4 在 100% 缩放下的自然宽度并居中（选项 B），仍不写死比例、不拉伸铺满
  assert.match(styles, /\.tw-drawer-body-attachment \.tw-resume-toolbar,\s*\.tw-drawer-body-attachment \.tw-resume-frame\s*\{[^}]*width: min\(100%, 794px\);/)
  assert.doesNotMatch(styles, /aspect-ratio: 210 \/ 297/)
  assert.doesNotMatch(styles, /\.tw-drawer-body-attachment \.tw-resume-frame\s*\{[^}]*flex: 1 1 auto;/)
})
