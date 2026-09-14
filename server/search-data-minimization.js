export const SEARCH_TEXT_POLICY_VERSION = 'identity-redacted-v1'
const unique = values => [...new Set(values)]

export function readSearchIdentities(db, candidateIds) {
  if (!Array.isArray(candidateIds) || candidateIds.length > 400) throw new Error('Identity projection exceeds bounded limit')
  const ids = unique(candidateIds.map(String))
  if (!ids.length) return new Map()
  return new Map(db.prepare(`SELECT id,name,phone,email FROM candidates WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map(row => [row.id, [row.name,row.phone,row.email].filter(value => typeof value === 'string' && value.trim().length >= 2)]))
}

export function redactSearchText(input, { identities = [], preserveLength = false } = {}) {
  let text = String(input ?? '')
  const mask = (value,label) => preserveLength ? value.replace(/[^\r\n]/g,' ') : label
  for (const literal of unique(identities.filter(value => typeof value === 'string' && value.trim().length >= 2)).sort((a,b) => b.length-a.length)) text = text.split(literal).join(mask(literal,'[个人信息]'))
  text = text
    .replace(/https?:\/\/[^\s<>"']+/giu, value => mask(value,'[链接]'))
    .replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, value => mask(value,'[邮箱]'))
    .replace(/(?<!\d)(?:\+?86[\s-]*)?1[3-9]\d(?:[\s-]?\d){8}(?!\d)/gu, value => mask(value,'[电话]'))
    .replace(/(?<!\d)(?:\+?\d{1,3}[\s-]+)?(?:\(?0\d{2,3}\)?[\s-]?)\d{7,8}(?!\d)/gu, value => mask(value,'[电话]'))
    .replace(/(?<![\dA-Za-z])\d{17}[\dXx](?![\dA-Za-z])/gu, value => mask(value,'[证件号]'))
    .replace(/(?:姓名|名字|联系人|出生日期|出生年月|出生地|身份证号?|证件号|家庭住址|详细地址|手机号码?|电话号码?|联系电话|电子邮箱|邮箱|微信号?|QQ号?|Name|Date of Birth|DOB|Contact|WeChat)\s*[:：]\s*[^\r\n,，;；]+/giu, value => mask(value,'[个人信息]'))
  return text
}
