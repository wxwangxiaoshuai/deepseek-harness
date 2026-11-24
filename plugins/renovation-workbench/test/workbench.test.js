/** Workbench Host, takeoff and reconciliation regression tests. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import ExcelJS from 'exceljs'
import { Ledger, quoteLine } from '../ledger.js'
import { parseDxf, drawingBytes, parseDrawing } from '../cad.js'
import { importQuote, exportQuote } from '../workbook.js'
import { apply } from '../index.js'

const line = {
  name: '客厅铺贴', room: '客厅', quantity: '12', unit: '㎡', price: '85.00',
  supply: 'owner', source: 'drawing', note: '业主供砖',
}
const date = '2026-11-23'
const dxf = (unit = 4, closed = 1) => Buffer.from([
  0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, unit, 0, 'ENDSEC',
  0, 'SECTION', 2, 'ENTITIES', 0, 'LWPOLYLINE', 8, 'Floor', 90, 4, 70, closed,
  10, 0, 20, 0, 10, 4000, 20, 0, 10, 4000, 20, 3000, 10, 0, 20, 3000,
  0, 'ENDSEC', 0, 'EOF', '',
].join('\n'))

test('drawings expose reviewable geometry, uncertain units and open boundaries', async () => {
  const drawing = parseDxf(dxf())
  const shape = drawing.shapes[0]
  assert.equal(drawing.metresPerUnit, 0.001)
  assert.equal(shape.length * 0.001, 14)
  assert.equal(shape.area * 0.001 ** 2, 12)
  assert.equal(parseDxf(dxf(0)).metresPerUnit, null)
  assert.equal(parseDxf(dxf(4, 0)).shapes[0].area, null)
  assert.throws(() => parseDxf(Buffer.from('not a drawing')), /invalid_cad/)
  await assert.rejects(drawingBytes(Buffer.from('AC1018'), 'test.dwg'), /dwg_converter_missing/)
})

test('DWG conversion accepts DXF expansion beyond the upload size', { skip: process.platform === 'win32' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cad-expansion-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const converter = join(dir, 'converter')
  await writeFile(converter, `#!${process.execPath}
const fs = require('node:fs')
const header = '999\\n' + 'a'.repeat(6 * 1024 * 1024) + '\\n'
fs.writeFileSync(process.argv[3], header + ${JSON.stringify(dxf().toString())})
`, { mode: 0o700 })
  const converted = await drawingBytes(Buffer.from('AC1032'), 'test.dwg', converter)
  assert.ok(converted.length > 5 * 1024 * 1024)
  assert.equal((await parseDrawing(converted)).shapes[0].area, 12_000_000)
})

test('DXF reads legacy Chinese code pages and preserves UTF-8 layer names', () => {
  const structure = dxf().toString().replace('$INSUNITS', '$DWGCODEPAGE\n3\nANSI_936\n9\n$INSUNITS')
  const [before, after] = structure.split('Floor')
  const gbk = Buffer.from([0xd3, 0xc3, 0xc6, 0xb7])
  assert.equal(parseDxf(Buffer.concat([Buffer.from(before), gbk, Buffer.from(after)])).shapes[0].layer, '用品')
  assert.equal(parseDxf(Buffer.from(before + '用品' + after)).shapes[0].layer, '用品')
})

test('money uses exact rounding and price tables identify invalid rows', async () => {
  assert.equal(quoteLine({ ...line, quantity: '0.5', price: '0.01' }).totalCents, 1)
  const file = new ExcelJS.Workbook()
  const tab = file.addWorksheet('报价')
  tab.addRows([['施工项', '数量', '单位', '单价'], ['铺砖', 12, '㎡', 85], ['旧墙', 2, '㎡', '待定']])
  const result = await importQuote(Buffer.from(await file.xlsx.writeBuffer()), false)
  assert.deepEqual(result.problems, [3])
  assert.equal(quoteLine(result.rows[0]).totalCents, 102_000)
  const exported = await exportQuote({ project: { name: '青禾苑' } }, {
    version: 1, tax: 'included', lines: [quoteLine(line)], totalCents: 102_000,
  })
  const opened = new ExcelJS.Workbook()
  await opened.xlsx.load(exported)
  assert.equal(opened.worksheets[0].getCell('H3').value, '图算')
  assert.equal(opened.worksheets[0].getCell('I3').value, 1020)
})

test('confirmed quote, changes, installment, duplicate payment and persisted balances', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-renovation-ledger-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'ledger.sqlite')
  const store = new Ledger(path)
  const project = store.create({ name: '青禾苑' }).id
  const add = (id, kind, fields) => store.add(project, { id, kind, ...fields })
  add('quote-1', 'quote', { tax: 'included', lines: [line] })
  add('contract', 'baseline', { quoteId: 'quote-1', note: '合同附件一' })
  add('change', 'change', { label: '插座增项', amount: '200' })
  assert.equal(store.view(project).totals.agreed, 102_000)
  add('confirm', 'confirm-change', { changeId: 'change', note: '双方确认单 1' })
  add('stage', 'installment', { label: '首期', date, amount: '1000' })
  add('cash', 'receipt', { label: '业主', date, amount: '600', installmentId: 'stage' })
  add('cash-2', 'receipt', { label: '业主', date, amount: '400', installmentId: 'stage' })
  add('cash-2', 'receipt', { label: '业主', date, amount: '400', installmentId: 'stage' })
  assert.throws(() => add('cash-2', 'receipt', { label: '业主', date, amount: '401' }), /operation_conflict/)
  add('advance', 'cost', { label: '辅料', date, amount: '800', advancedBy: '张工' })
  add('reimburse', 'payment', { label: '报销', date, amount: '800', costId: 'advance' })
  assert.throws(() => add('overpay', 'payment', { label: '报销', date, amount: '0.01', costId: 'advance' }), /invalid_payment/)
  const otherProject = store.create({ name: '水木居' }).id
  const file = store.saveFile(project, '凭据.pdf', 'digest', Buffer.from('receipt'))
  assert.equal(store.saveFile(project, '凭据.pdf', 'digest', Buffer.from('receipt')).duplicate, true)
  assert.equal(store.file(otherProject, file.id), undefined)
  assert.throws(() => store.add(otherProject, { id: 'entry', kind: 'cost', label: '费用', date, amount: '1', fileIds: [file.id] }), /file_missing/)
  store.close()
  const reopened = new Ledger(path)
  try {
    assert.deepEqual(reopened.publicView(project).totals, {
      agreed: 122_000, received: 100_000, outstanding: 22_000, overpayment: 0, cost: 80_000, paid: 80_000,
      payable: 0, margin: 42_000,
    })
    assert.equal(reopened.publicView(project).records.some(row => 'fingerprint' in row), false)
    assert.equal(reopened.publicView(otherProject).records.length, 0)
  } finally {
    reopened.close()
  }
})

test('Host route protects the page and processes subsequent owner operations', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-renovation-host-test-'))
  const handlers = []
  let dispose
  apply({
    dshHomePath: (...parts) => join(dir, ...parts),
    logger: { warn: t.diagnostic.bind(t) },
    connection: { admit: () => ({ rejection: 401 }) },
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    effect: callback => { dispose = callback() },
    webServer: {
      register(route) {
        handlers.push(route)
        return () => handlers.pop()
      },
    },
  })
  const server = createServer((req, res) => {
    const role = req.headers['x-test-role']
    const peer = role ? { principal: { kind: role } } : undefined
    void handlers[0].handler(req, res, peer)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    await dispose()
    await rm(dir, { recursive: true, force: true })
  })
  const url = path => 'http://127.0.0.1:' + server.address().port + '/renovation-workbench/' + path
  const send = (path, payload, role = 'owner') => fetch(url(path), {
    method: 'POST', headers: { 'x-test-role': role, 'x-renovation-workbench': '1' },
    body: Buffer.isBuffer(payload) ? payload : JSON.stringify(payload),
  })
  assert.equal((await fetch(url(''))).status, 401)
  assert.equal((await send('api/projects', { name: '访客项目' }, 'guest')).status, 403)
  assert.match(await (await fetch(url(''), { headers: { 'x-test-role': 'owner' } })).text(), /装修项目工作台/)
  const res = await send('api/projects', { name: '青禾苑' })
  assert.equal(res.status, 201)
  const project = (await res.json()).id
  const drawing = await send('api/drawing?project=' + project + '&name=floor.dxf', dxf())
  assert.equal(drawing.status, 200)
  const geometry = await drawing.json()
  assert.equal(geometry.shapes[0].area, 12_000_000)
  const drawingLine = { ...line, drawing: { fileId: geometry.fileId, shapeId: '1', scale: 0.001, metric: 'area' } }
  const endpoint = 'api/record?project=' + project
  const payload = { id: 'quote-01', kind: 'quote', tax: 'included' }
  assert.equal((await send(endpoint, { ...payload, lines: [{ ...drawingLine, quantity: '13.0000' }] })).status, 400)
  const result = await send(endpoint, { ...payload, lines: [{ ...drawingLine, quantity: '12.0000' }] })
  assert.equal(result.status, 200)
  assert.equal((await result.json()).records[0].totalCents, 102_000)
})

test('receipt extraction leaves conflicting amounts and dates for manual review', async () => {
  const { receiptFields } = await import('../receipt.js')
  assert.deepEqual(receiptFields('支付金额：￥1,220.50\n收款人：瓷砖店\n交易时间：2026年11月23日'), {
    amount: '1220.50', date: '2026-11-23', label: '瓷砖店',
  })
  assert.deepEqual(receiptFields('支付金额：100\n价税合计：200\n2026-11-22\n2026-11-23'), {
    amount: '', date: '', label: '',
  })
})

test('an account transfer stays outside project money, and a partial payment is recorded once', () => {
  const store = new Ledger(':memory:')
  try {
    const { id: project } = store.create({ name: '项目' })
    const source = store.addAccount({ name: '微信', opening: '100' }).accounts[0]
    const target = store.addAccount({ name: '现金' }).accounts[1]
    const add = (id, kind, extra) => store.add(project, { id, kind, ...extra })
    add('cost', 'cost', { date, label: '建材', amount: '30', paidAmount: '10', accountId: source.id })
    assert.equal(store.view(project).totals.payable, 2000)
    assert.throws(() => add('overpay', 'payment', { date, label: '结款', amount: '20.01', costId: 'cost' }), /invalid_payment/)
    add('pay', 'payment', { date, label: '结款', amount: '20', costId: 'cost', accountId: source.id })
    const transfer = { id: 'transfer', amount: '15', source: source.id, target: target.id, date }
    store.transfer(transfer)
    const { accounts } = store.transfer(transfer)
    assert.equal(accounts[0].balance, 5500)
    assert.equal(accounts[1].balance, null)
    assert.equal(accounts[1].movement, 1500)
    assert.deepEqual([store.view(project).totals.cost, store.view(project).totals.payable], [3000, 0])
  } finally {
    store.close()
  }
})

test('chat tools read only owner uploads from the active session and save a versioned quote', async () => {
  const { registerChatTools } = await import('../chat-tools.js')
  const store = new Ledger(':memory:')
  try {
    const tools = new Map()
    const ref = { attachmentId: 'cad-upload', name: 'floor.dxf', bytes: dxf().length }
    const owner = { kind: 'user', rpcId: 'request' }
    const guest = { ...owner, principal: { kind: 'guest' } }
    const message = (source, attachment) => ({ type: 'user/message', data: {
      source, content: attachment ? [{ type: 'file', attachment }] : [],
    } })
    const exec = source => ({
      callId: 'call-1', signal: new AbortController().signal, agent: { session: {
        id: 'test-session', inheritedEventCount: 0,
        snapshotEvents: () => [message(owner, ref), { type: 'turn/start' }, message(source)],
      } },
    })
    const dispose = registerChatTools({
      tools: { register: value => { tools.set(value.name, value); return () => tools.delete(value.name) } },
      systemPrompt: { section: () => () => {} },
      webServer: { getOrigin: () => 'http://127.0.0.1:39732' },
      attachments: { async *readFileStream() { yield dxf() } },
    }, store, {}, (run, signal) => run(signal))
    const inspect = tools.get('renovation_inspect_uploads')
    const generate = tools.get('renovation_generate_quote')
    assert.equal((await inspect.execute({}, exec(guest))).code, 'chat_owner_required')
    assert.equal((await inspect.execute({ attachmentId: 'other-conversation' }, exec(owner))).code, 'chat_attachment_unavailable')
    const inspected = await inspect.execute({ attachmentId: ref.attachmentId }, exec(owner))
    assert.equal(inspected.result.boundaries[0].area, 12_000_000)
    assert.deepEqual(inspected.result.boundaries[0].bounds, [0, 0, 4000, 3000])
    assert.equal(inspected.result.closedCount, 1)
    const otherLayer = await inspect.execute({ attachmentId: ref.attachmentId, layer: 'Furniture' }, exec(owner))
    assert.equal(otherLayer.result.matchedCount, 0)
    const invalidOffset = await inspect.execute({ attachmentId: ref.attachmentId, offset: -1 }, exec(owner))
    assert.equal(invalidOffset.code, 'invalid_cad_selection')
    const input = { projectName: '聊天报价', scope: '客厅铺砖', purpose: 'formal', tax: 'included', lines: [
      { ...line, quantity: '999', drawing: { attachmentId: ref.attachmentId, shapeId: '1', scale: .001, metric: 'area' } },
    ] }
    const applied = await generate.execute(input, exec(owner))
    assert.equal(applied.result.totalCents, 102_000)
    assert.match(applied.result.reportUrl, /renovation-workbench\/\?project=/)
    assert.deepEqual(await generate.execute(input, exec(owner)), applied)
    const report = store.publicView(applied.result.projectId)
    assert.equal(report.records.length, 1)
    assert.equal(report.records[0].lines[0].quantity, '12.0000')
    assert.equal(report.totals.agreed, null)
    dispose()
    assert.equal(tools.size, 0)
  } finally {
    store.close()
  }
})
