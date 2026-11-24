/** Read one explicit tabular quote template and write customer and internal workbooks. */
import ExcelJS from 'exceljs'
import yauzl from 'yauzl'
import { InputError, quoteLine } from './ledger.js'

const columns = ['施工项', '房间', '数量', '单位', '单价', '供料', '说明']
const supplyNames = { owner: '业主供料', team: '团队供料', labour: '仅人工' }
const quantityNames = { drawing: '图算', manual: '手填', estimate: '暂估' }

async function validateArchive(bytes) {
  await new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, archive) => {
      if (error) return reject(new InputError('invalid_workbook'))
      let inflated = 0
      let count = 0
      const fail = () => {
        archive.close()
        reject(new InputError('invalid_workbook'))
      }
      archive.on('error', fail)
      archive.on('end', resolve)
      archive.on('entry', entry => {
        inflated += entry.uncompressedSize
        count++
        if (inflated > 12 * 1024 * 1024 || count > 100 || entry.isEncrypted()) return fail()
        archive.openReadStream(entry, (failure, stream) => {
          if (failure) return fail()
          stream.on('error', fail)
          stream.on('end', () => archive.readEntry())
          stream.resume()
        })
      })
      archive.readEntry()
    })
  })
}

export async function importQuote(bytes, pricesOnly) {
  await validateArchive(bytes)
  const book = new ExcelJS.Workbook()
  try {
    await book.xlsx.load(bytes)
  } catch (error) {
    throw new InputError('invalid_workbook', { cause: error })
  }
  const sheet = book.worksheets[0]
  if (!sheet || sheet.rowCount > 509 || sheet.columnCount > 35) throw new InputError('invalid_workbook')
  const headers = new Map()
  const headerRow = [1, 2].find(index => sheet.getRow(index).values.includes('施工项')) ?? 1
  sheet.getRow(headerRow).eachCell((cell, column) => headers.set(cell.text.trim(), column))
  const required = pricesOnly ? ['施工项', '单位', '单价'] : ['施工项', '数量', '单位', '单价']
  if (required.some(header => !headers.has(header))) throw new InputError('invalid_workbook_headers')
  const rows = []
  const problems = []
  let afterTotal = false
  const exported = headerRow === 2 && sheet.getCell('B1').text === '报价版本'
  sheet.eachRow((row, index) => {
    if (exported && index > headerRow && row.getCell(1).text === '合计' && row.getCell(3).value == null) afterTotal = true
    if (index <= headerRow || afterTotal) return
    if (rows.length + problems.length >= 500) throw new InputError('invalid_workbook')
    const value = key => headers.has(key) ? row.getCell(headers.get(key)).text.trim() : ''
    try {
      const supply = value('供料')
      const supplyKey = supply ? Object.keys(supplyNames).find(key => supplyNames[key] === supply) : 'team'
      const line = { name: value('施工项'), room: value('房间'), quantity: pricesOnly ? '1' : value('数量'),
        unit: value('单位'), price: value('单价'), note: value('说明'), supply: supplyKey, source: 'manual' }
      quoteLine(line)
      rows.push(line)
    } catch (error) {
      if (!(error instanceof InputError)) throw error
      problems.push(index)
    }
  })
  return { rows, problems }
}

export async function exportQuote(view, quote) {
  const book = new ExcelJS.Workbook()
  const tab = book.addWorksheet('报价单')
  tab.addRow([view.project.name, '报价版本', quote.version, quote.tax === 'included' ? '含税' : '未含税'])
  tab.addRow([...columns, '数量来源', '小计'])
  for (const line of quote.lines) {
    tab.addRow([line.name, line.room, Number(line.quantity), line.unit, line.unitCents / 100,
      supplyNames[line.supply], line.note, quantityNames[line.source], line.totalCents / 100])
  }
  tab.addRow(['合计', quote.totalCents / 100])
  if (quote.purpose === 'budget') tab.addRow(['用途', '预算参考，金额以正式报价为准'])
  for (const [key, label] of [['scope', '包含范围'], ['exclusions', '不包含'], ['estimateTerms', '暂估与结算'],
    ['paymentTerms', '付款约定'], ['validUntil', '有效期至']]) {
    if (quote[key]) tab.addRow([label, quote[key]])
  }
  tab.columns.forEach(column => { column.width = 18 })
  return book.xlsx.writeBuffer()
}

export async function exportLedger(view) {
  const book = new ExcelJS.Workbook()
  const amounts = book.addWorksheet('项目汇总')
  amounts.addRow(['项目', view.project.name])
  for (const [key, name] of [
    ['agreed', '约定金额'], ['received', '已收'], ['outstanding', '待收'], ['overpayment', '超收'],
    ['cost', '成本'], ['paid', '已付'], ['payable', '待付'], ['margin', '项目毛利'],
  ]) amounts.addRow([name, view.totals[key] === null ? '' : view.totals[key] / 100])
  const tab = book.addWorksheet('明细')
  tab.addRow(['类型', 'ID', '事项', '日期', '金额', '垫资人', '关联记录', '凭据', '说明', '账户', '费用登记时已付'])
  const names = { baseline: '签约基线', change: '变更', 'confirm-change': '变更确认', installment: '期款', receipt: '收款', cost: '费用', payment: '付款' }
  for (const row of view.records) {
    if (!(row.kind in names)) continue
    tab.addRow([names[row.kind], row.id, row.label, row.date, row.cents == null ? '' : row.cents / 100,
      row.advancedBy, row.quoteId || row.installmentId || row.costId || row.changeId, row.fileIds?.join(', '), row.note, view.accounts?.find(account => account.id === row.accountId)?.name,
      row.paidCents ? row.paidCents / 100 : ''])
  }
  tab.columns.forEach(column => { column.width = 22 })
  return book.xlsx.writeBuffer()
}

/** Write agreed changes and collection totals without supplier or cost information. */
export async function exportSettlement(view) {
  const book = new ExcelJS.Workbook()
  const sheet = book.addWorksheet('项目结算')
  const baseline = view.records.find(row => row.kind === 'baseline')
  const quote = view.records.find(row => row.kind === 'quote' && row.id === baseline?.quoteId)
  sheet.addRow(['项目', view.project.name])
  sheet.addRow(['签约金额', (baseline?.cents ?? quote?.totalCents ?? 0) / 100])
  sheet.addRow(['已确认增减项', '金额（元）', '确认依据'])
  for (const confirmation of view.records.filter(row => row.kind === 'confirm-change')) {
    const change = view.records.find(row => row.id === confirmation.changeId)
    sheet.addRow([change.label, change.cents / 100, confirmation.note])
  }
  sheet.addRow(['结算金额', view.totals.agreed / 100])
  sheet.addRow(['已收', view.totals.received / 100])
  sheet.addRow(['待收', view.totals.outstanding / 100])
  if (view.totals.overpayment) sheet.addRow(['超收', view.totals.overpayment / 100])
  sheet.columns.forEach(column => { column.width = 24 })
  return book.xlsx.writeBuffer()
}
