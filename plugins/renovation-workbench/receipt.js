/** Optional local image transcription for editable receipt drafts. */
import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { InputError } from './ledger.js'

export function receiptFields(text) {
  const normalized = text.normalize('NFKC')
  const totals = [...normalized.matchAll(/(?:实付金额|实付款|支付金额|付款金额|收款金额|合计金额|价税合计|实付)\s*[:：]?\s*[¥￥]?\s*(\d[\d,]*(?:\.\d{1,2})?)/g)]
  const amounts = [...new Set(totals.map(match => match[1].replaceAll(',', '')))]
  const dates = [...normalized.matchAll(/\b(20\d{2})\s*[-年/.]\s*(\d{1,2})\s*[-月/.]\s*(\d{1,2})\s*(?:日|\b)/g)]
  const days = [...new Set(dates.map(([, year, month, day]) => [year, month.padStart(2, '0'), day.padStart(2, '0')].join('-')))]
  const party = normalized.match(/(?:收款人|商户名称|对方账户|付款人)\s*[:：]\s*([^\r\n]{1,100})/)
  return { amount: amounts.length === 1 ? amounts[0] : '', date: days.length === 1 ? days[0] : '', label: party?.[1].trim() ?? '' }
}

export async function extractReceipt(bytes, executable, signal) {
  if (typeof executable !== 'string' || !isAbsolute(executable)) throw new InputError('ocr_unavailable')
  const png = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  const webp = bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'
  if (!png && !jpeg && !webp) throw new InputError('ocr_image_required')
  const text = await new Promise((resolve, reject) => {
    const child = execFile(executable, ['stdin', 'stdout', '-l', 'chi_sim+eng'], {
      env: {}, signal, encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024, windowsHide: true,
    }, (error, stdout) => error ? reject(new InputError('ocr_failed', { cause: error })) : resolve(stdout))
    child.stdin.on('error', error => reject(new InputError('ocr_failed', { cause: error })))
    child.stdin.end(bytes)
  })
  return receiptFields(text)
}
