/** Browser forms, CAD preview and project navigation. */
const app = document.querySelector('#app')
const drafts = new Map()
const currency = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' })
const money = value => value == null ? '—' : currency.format(value / 100)
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date())
const labelOf = {
  receipt: '收款', cost: '费用或垫资', payment: '付款或报销', installment: '收款计划',
  change: '增减项', 'confirm-change': '增减项确认', baseline: '签约依据', owner: '业主供料',
  team: '团队供料', labour: '仅人工', drawing: '图算', manual: '手填', estimate: '暂估',
}
const errors = {
  forbidden: '请用工作台所有者账户重新打开此页', project_missing: '找不到项目，请重新选择',
  invalid_amount: '检查金额，最多保留两位小数', invalid_quantity: '检查工程量，最多保留四位小数',
  invalid_payment: '请选择有效的费用，且付款金额不能超过剩余应付',
  account_missing: '请选择已有账户', invalid_transfer: '请选择两个不同的账户，并检查金额',
  estimate_terms_required: '请说明暂估项目如何复量和结算',
  invalid_input: '请检查已填字段', invalid_date: '请选择有效日期',
  invalid_quote: '请至少填写一条报价，并核对单价', invalid_change: '请先登记签约依据，并检查增减项是否已确认',
  baseline_exists: '项目已有签约依据', operation_conflict: '提交内容已变更，请刷新项目核对记录',
  invalid_cad: '图纸格式无法读取，请检查文件或另存为文本 DXF',
  no_geometry: '未找到可测量的二维直线或多段线，可补图或手填',
  drawing_too_large: '图纸超出处理范围，请拆分图纸后重试',
  dwg_converter_missing: '此工作台尚未配置 DWG 转换器，可先上传 DXF',
  dwg_conversion_failed: '无法转换该 DWG，请检查版本或另存为 DXF',
  invalid_workbook: '无法读取表格，请上传有效的 XLSX',
  invalid_workbook_headers: '检查表头中的施工项、单位、单价和数量',
  upload_too_large: '文件过大，最多支持 5 MB', invalid_attachment: '请选择图片、PDF、XML 或 OFD 凭据',
  ocr_unavailable: '此工作台尚未安装凭据识别，可直接手填',
  ocr_image_required: '请选择 PNG、JPEG 或 WebP 图片进行识别',
  ocr_failed: '未能识别这张凭据，请手填或换一张图片',
  operation_failed: '操作失败，请稍后重试', file_missing: '找不到当前项目的凭据',
}
let projects = []
let view = null
let tab = 'overview'
let ledgerTab = 'todo'
let accountState = { accounts: [], transfers: [] }
let modal
let status = ''

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
    else if (key in node && key !== 'style') node[key] = value
    else node.setAttribute(key, value)
  }
  node.append(...children.filter(child => child != null))
  return node
}

function field(title, name, props = {}) {
  return el('label', {}, title, el('input', { name, 'aria-label': title, ...props }))
}

function select(title, name, entries, selected) {
  const input = el('select', { name, 'aria-label': title }, ...entries.map(([key, title]) => el('option', { value: key }, title)))
  if (selected != null) input.value = selected
  return el('label', {}, title, input)
}

function submit(title) {
  return el('button', { type: 'submit', className: 'primary' }, title)
}

function url(path, params = {}) {
  return path + '?' + new URLSearchParams(Object.entries(params).filter(([, value]) => value != null))
}

async function api(path, params, data) {
  const response = await fetch(url('api/' + path, params), data === undefined ? {} : {
    method: 'POST', headers: { 'X-Renovation-Workbench': '1' },
    body: data instanceof Blob ? data : JSON.stringify(data),
  })
  if (response.status === 401) throw new Error('forbidden')
  const result = await response.json()
  if (!response.ok) throw new Error(result.code)
  return result
}

function report(message) {
  status = message
  const notice = app.querySelector('.notice')
  if (notice) notice.textContent = message
  const feedback = modal?.querySelector('.form-feedback')
  if (feedback) feedback.textContent = message
}

function run(action) {
  return async event => {
    event.preventDefault()
    if (app.getAttribute('aria-busy') === 'true') return
    const source = event.currentTarget
    const data = source instanceof HTMLFormElement ? new FormData(source) : null
    app.setAttribute('aria-busy', 'true')
    const controls = [...app.querySelectorAll('button,input,select'), ...modal?.querySelectorAll('button,input,select') ?? []].filter(control => !control.disabled)
    controls.forEach(control => { control.disabled = true })
    report('')
    try {
      await action(data)
    } catch (error) {
      report(errors[error.message] ?? errors.operation_failed)
    } finally {
      controls.forEach(control => { control.disabled = false })
      app.removeAttribute('aria-busy')
    }
  }
}

function form(onSubmit, ...children) {
  return el('form', { className: 'fields', onsubmit: run(onSubmit) }, ...children)
}

function button(title, action) {
  return el('button', { type: 'button', onclick: run(action) }, title)
}

function section(title, ...children) {
  return el('section', {}, title ? el('h2', {}, title) : null, ...children)
}

function table(headings, rows) {
  return el('div', { className: 'scroll', tabIndex: 0 }, el('table', {},
    el('thead', {}, el('tr', {}, ...headings.map(title => el('th', { scope: 'col' }, title)))),
    el('tbody', {}, ...rows.map(row => el('tr', {}, ...row.map(cell => el('td', {}, cell)))))))
}

function loadDraft() {
  const id = view.project.id
  if (!drafts.has(id)) {
    const saved = localStorage.getItem('renovation-quote:' + id)
    drafts.set(id, { lines: [], drawing: null, tax: 'included', pending: null, ...(saved ? JSON.parse(saved) : {}) })
  }
  return drafts.get(id)
}

function persistDraft() {
  const { drawing, pending, ...draft } = loadDraft()
  localStorage.setItem('renovation-quote:' + view.project.id, JSON.stringify(draft))
}

async function setProject(id) {
  view = await api('project', { project: id })
  localStorage.setItem('renovation-project', id)
  tab = 'overview'
  render()
}

async function record(input) {
  const draft = loadDraft()
  const key = JSON.stringify(input)
  if (draft.pending?.key !== key) draft.pending = { key, id: crypto.randomUUID() }
  view = await api('record', { project: view.project.id }, { ...input, id: draft.pending.id })
  draft.pending = null
  render()
  report('已保存')
  return view
}

function draw(canvas, drawing, selected) {
  const context = canvas.getContext('2d')
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const shape of drawing.shapes) {
    for (const [x, y] of shape.points) {
      minX = Math.min(x, minX)
      minY = Math.min(y, minY)
      maxX = Math.max(x, maxX)
      maxY = Math.max(y, maxY)
    }
  }
  const scale = 0.9 * Math.min(canvas.width / (maxX - minX || 1), canvas.height / (maxY - minY || 1))
  context.clearRect(0, 0, canvas.width, canvas.height)
  for (const shape of drawing.shapes) {
    context.beginPath()
    shape.points.forEach(([x, y], index) => {
      const px = (x - minX) * scale + (canvas.width - (maxX - minX) * scale) / 2
      const py = canvas.height - (y - minY) * scale - (canvas.height - (maxY - minY) * scale) / 2
      if (index === 0) context.moveTo(px, py)
      else context.lineTo(px, py)
    })
    if (shape.closed) context.closePath()
    context.strokeStyle = selected === shape.id ? '#ffd379' : '#8bb9ac'
    context.lineWidth = selected === shape.id ? 3 : 1
    context.stroke()
  }
}

function drawingPanel(draft, fill, selected) {
  const drawing = draft.drawing
  const files = view.files.filter(file => /\.(dxf|dwg)$/i.test(file.name))
  const upload = form(async fields => {
    const file = fields.get('file')
    draft.drawing = await api('drawing', { project: view.project.id, name: file.name }, file)
    view = await api('project', { project: view.project.id })
    drawDraft(draft, fill)
    if (draft.drawing.duplicate) report('图纸已在当前项目中，已重新打开')
  }, field('DWG 或 DXF', 'file', { type: 'file', accept: '.dwg,.dxf', required: true }), submit('上传图纸'))
  const reopen = files.length ? form(async fields => {
    draft.drawing = await api('read-drawing', { project: view.project.id, file: fields.get('file') }, {})
    drawDraft(draft, fill)
  }, select('已保存图纸', 'file', files.map(file => [file.id, file.name])), submit('打开')) : null
  if (!drawing) return section('图纸算量', upload, reopen)
  const canvas = el('canvas', { width: 900, height: 420, role: 'img', 'aria-label': '图纸测量预览' })
  const output = el('output', { 'aria-live': 'polite' })
  const shapes = select('测量边界', 'shape', drawing.shapes.map(shape => [shape.id, shape.layer + ' · ' + shape.id]))
  if (selected && drawing.shapes.some(shape => shape.id === selected.shapeId)) shapes.lastChild.value = selected.shapeId
  const lengthKnown = field('该边界实测总长（米，可选）', 'known', { type: 'number', min: '0.0001', step: 'any' })
  const unit = select('图纸单位', 'scale', [['', '请选择'], ['0.001', '毫米'], ['0.01', '厘米'], ['1', '米'], ['0.0254', '英寸'], ['0.3048', '英尺']], drawing.metresPerUnit)
  const method = select('测量方式', 'method', [['area', '面积'], ['length', '长度']], selected?.metric)
  if (selected && selected.scale !== drawing.metresPerUnit) {
    const shape = drawing.shapes.find(item => item.id === selected.shapeId)
    if (shape) lengthKnown.lastChild.value = shape.length * selected.scale
  }
  const interpret = () => {
    const shape = drawing.shapes.find(item => item.id === shapes.lastChild.value)
    const known = Number(lengthKnown.lastChild.value)
    const scale = known > 0 ? known / shape.length : Number(unit.lastChild.value)
    const area = method.lastChild.value === 'area'
    const result = !scale || (area && shape.area == null) ? null : area ? shape.area * scale ** 2 : shape.length * scale
    draw(canvas, drawing, shape.id)
    output.textContent = result === null ? '请确认单位，面积需要闭合边界' : result.toFixed(4) + (area ? ' ㎡' : ' m')
    return { result, area, reference: { fileId: drawing.fileId, shapeId: shape.id, scale, metric: area ? 'area' : 'length' } }
  }
  for (const control of [shapes, lengthKnown, unit, method]) control.addEventListener('input', interpret)
  const picker = fill ? form(async () => {
    const { result, area, reference } = interpret()
    if (!result || !Number.isFinite(result)) {
      report('请先选择可测量的边界并确认单位')
      return
    }
    fill(result.toFixed(4), area ? '㎡' : 'm', reference)
  }, shapes, unit, lengthKnown, method, output, submit('使用这个工程量')) : output
  interpret()
  return section('图纸算量', upload, reopen, canvas,
    drawing.unsupported ? el('p', { className: 'muted' }, '有 ' + drawing.unsupported + ' 个对象未纳入算量，请核对图纸或手填。') : null, picker)
}

const units = ['㎡', 'm', '个', '点', '项', '套'].map(unit => [unit, unit])
const supplyOptions = ['team', 'owner', 'labour'].map(key => [key, labelOf[key]])
const templates = {
  bathroom: { title: '卫生间改造', room: '卫生间', lines: [['墙地砖拆除', '㎡'], ['地面防水', '㎡'], ['地砖铺贴', '㎡'], ['洁具安装', '套']] },
  refresh: { title: '局部翻新', room: '客厅', lines: [['墙面基层处理', '㎡'], ['墙面涂刷', '㎡'], ['踢脚线安装', 'm']] },
}

function heading(title, subtitle, ...actions) {
  return el('div', { className: 'heading' }, el('div', {}, el('h2', {}, title), subtitle && el('p', { className: 'muted' }, subtitle)),
    actions.some(Boolean) ? el('div', { className: 'actions' }, ...actions) : null)
}

function action(title, fn, style = '') {
  const control = button(title, fn)
  control.className = style
  return control
}

function navigate(next) {
  tab = next
  status = ''
  render()
}

function openDialog(title, content) {
  modal?.close()
  const dialog = el('dialog', { 'aria-label': title }, heading(title, '', action('关闭', () => dialog.close())),
    el('p', { className: 'form-feedback notice', role: 'status' }), content)
  modal = dialog
  dialog.addEventListener('close', () => {
    dialog.remove()
    if (modal === dialog) modal = undefined
  })
  app.after(dialog)
  dialog.showModal()
  return dialog
}

function drawDraft(draft, fill) {
  const dialog = modal
  dialog.lastElementChild.replaceWith(drawingPanel(draft, fill))
}

function metrics(entries) {
  return el('dl', { className: 'metrics' }, ...entries.map(([label, value]) => el('div', {},
    el('dt', {}, label), el('dd', {}, money(value)))))
}

function list(items, empty) {
  return items.length ? el('ul', { className: 'rows' }, ...items) : el('p', { className: 'empty' }, empty)
}

function item(title, detail, ...controls) {
  return el('li', {}, el('div', {}, el('strong', {}, title), detail ? el('small', {}, detail) : null),
    controls.length ? el('div', { className: 'actions row-actions' }, ...controls) : null)
}

function openCosts() {
  const paid = new Map()
  for (const row of view.records.filter(row => row.kind === 'payment')) paid.set(row.costId, (paid.get(row.costId) ?? 0) + row.cents)
  return view.records.filter(row => row.kind === 'cost').map(row => ({
    ...row, due: row.cents - (row.paidCents ?? 0) - (paid.get(row.id) ?? 0),
  })).filter(row => row.due > 0)
}

function installmentBalances() {
  return view.records.filter(row => row.kind === 'installment').map(row => ({
    ...row, due: row.cents - view.records.filter(item => item.kind === 'receipt' && item.installmentId === row.id)
      .reduce((total, item) => total + item.cents, 0),
  })).filter(row => row.due > 0)
}

function history(limit = Infinity) {
  const records = view.records.filter(row => ['receipt', 'cost', 'payment'].includes(row.kind)).reverse().slice(0, limit)
  return list(records.map(row => item(row.label, [
    row.advancedBy ? row.advancedBy + '垫付' : labelOf[row.kind], row.date,
    view.accounts.find(account => account.id === row.accountId)?.name,
    row.paidCents ? '登记时已付 ' + money(row.paidCents) : '',
  ].filter(Boolean).join(' · '), el('span', { className: 'amount' }, money(row.cents)),
  ...(row.fileIds ?? []).map((file, i) => el('a', { href: url('api/file', { project: view.project.id, file }) }, '凭据 ' + (i + 1))))),
  '还没有收支记录')
}

function todoPanel() {
  const costs = openCosts()
  const installments = installmentBalances()
  return section('待处理', list([
    ...installments.map(row => item(row.label, '待收 ' + money(row.due) + ' · ' + row.date,
      action('记收款', () => entryDialog('receipt', row)))),
    ...costs.map(row => item(row.advancedBy ? '报销给' + row.advancedBy : row.label,
      [row.advancedBy ? row.label : '', row.dueDate ? '到期 ' + row.dueDate : '', '待付 ' + money(row.due)].filter(Boolean).join(' · '),
      action(row.advancedBy ? '记报销' : '记付款', () => entryDialog('payment', row)))),
  ], '当前没有待付、待报销或分期应收记录'))
}

function overview() {
  const baseline = view.records.find(row => row.kind === 'baseline')
  return [
    el('section', { className: 'overview-panel' },
      heading(view.project.name, view.project.city, action('查看报价', () => navigate('quote')), action('记一笔', chooseEntry, 'primary')),
      metrics([[baseline ? '已确认金额' : '约定金额', view.totals.agreed], ['已收', view.totals.received],
        ['待收', view.totals.outstanding], ['待付及报销', view.totals.payable]])),
    el('div', { className: 'split' }, todoPanel(), section('最近收支', history(4))),
  ]
}

function startDraft(lines = [], extra = {}) {
  const draft = loadDraft()
  Object.assign(draft, { lines, draftOpen: true, step: lines.length ? 'lines' : 'start', ...extra })
  persistDraft()
  render()
}

function editQuoteLine(index, values) {
  const draft = loadDraft()
  const line = { name: '', room: '', quantity: '', unit: '㎡', price: '', supply: 'team', source: 'manual', note: '', ...values }
  const formNode = form(async fields => {
    const next = { ...line, ...Object.fromEntries(fields) }
    if (next.source !== 'drawing') delete next.drawing
    if (index === undefined) draft.lines.push(next)
    else draft.lines[index] = next
    persistDraft()
    modal.close()
    render()
  },
  field('施工项', 'name', { value: line.name, required: true }), field('房间', 'room', { value: line.room }),
  field('工程量', 'quantity', { inputMode: 'decimal', value: line.quantity }), select('单位', 'unit', units, line.unit),
  field('单价（元）', 'price', { inputMode: 'decimal', value: line.price, placeholder: '缺价可先留空' }),
  select('供料范围', 'supply', supplyOptions, line.supply),
  select('数量来源', 'source', (line.drawing ? ['manual', 'estimate', 'drawing'] : ['manual', 'estimate']).map(key => [key, labelOf[key]]), line.source),
  field('做法及包含范围', 'note', { value: line.note }), submit('保存施工项'))
  for (const input of [formNode.elements.quantity, formNode.elements.unit]) {
    input.addEventListener('input', () => { if (formNode.elements.source.value === 'drawing') formNode.elements.source.value = 'manual' })
  }
  openDialog(index === undefined ? '添加施工项' : '编辑施工项', formNode)
}

function setMeasuredLine(index) {
  const draft = loadDraft()
  const fill = (quantity, unit, drawing) => {
    const line = draft.lines[index]
    const matched = view.prices.find(price => price.name === line.name && price.unit === unit && price.supply === line.supply)
    const price = line.unit !== unit ? matched?.price ?? '' : line.price || matched?.price || ''
    draft.lines[index] = { ...line, quantity, unit, price, source: 'drawing', drawing }
    persistDraft()
    modal.close()
    render()
  }
  openDialog('从图纸取量', drawingPanel(draft, fill))
}

function showDrawing(reference) {
  return async () => {
    const draft = loadDraft()
    if (reference) draft.drawing = await api('read-drawing', { project: view.project.id, file: reference.fileId }, {})
    openDialog('项目图纸', drawingPanel(draft, null, reference))
  }
}

function importDialog(pricesOnly) {
  openDialog(pricesOnly ? '导入团队价表' : '导入已有报价', form(async fields => {
    const result = await api('import', { project: view.project.id, prices: pricesOnly ? '1' : '0' }, fields.get('file'))
    if (!result.rows.length || (pricesOnly && result.problems.length)) {
      return report(result.problems.length ? '请核对第 ' + result.problems.join('、') + ' 行' : '表里没有可用行')
    }
    if (pricesOnly) view = await api('project', { project: view.project.id })
    else startDraft(result.rows)
    modal.close()
    render()
    report(result.problems.length ? '已导入有效行，请核对第 ' + result.problems.join('、') + ' 行' : '导入完成')
  }, field('Excel 表格', 'file', { type: 'file', accept: '.xlsx', required: true }), submit('导入')))
}

function chooseTemplate(fromDrawing = false) {
  openDialog(fromDrawing ? '选择要算量的施工范围' : '选择施工模板', form(async fields => {
    const template = templates[fields.get('template')]
    const room = fields.get('room').trim() || template.room
    const supply = { half: 'team', full: 'team', labour: 'labour' }[fields.get('contract')]
    const names = fields.getAll('included')
    if (!names.length) return report('请至少选择一项施工内容')
    const lines = template.lines.filter(([name]) => names.includes(name)).map(([name, unit]) => {
      const itemSupply = fields.get('contract') === 'half' && name === '地砖铺贴' ? 'owner' : supply
      const price = view.prices.find(row => row.name === name && row.unit === unit && row.supply === itemSupply)
      return { name, room, unit, quantity: '', price: price?.price ?? '', source: 'manual', supply: itemSupply, note: price?.note ?? '' }
    })
    modal.close()
    startDraft(lines, { scope: template.title + ' · ' + room })
    if (fromDrawing) setMeasuredLine(0)
  }, ...templateControls(), submit('生成施工清单')))
}

function templateControls() {
  const selector = select('施工类型', 'template', Object.entries(templates).map(([key, value]) => [key, value.title]))
  const options = el('fieldset', { className: 'checks' })
  const showOptions = () => options.replaceChildren(el('legend', {}, '包含的施工项'),
    ...templates[selector.lastChild.value].lines.map(([name]) => el('label', {},
      el('input', { type: 'checkbox', name: 'included', value: name, checked: true }), name)))
  selector.addEventListener('change', showOptions)
  showOptions()
  return [selector, field('房间（可选）', 'room'),
    select('承包方式', 'contract', [['half', '半包'], ['labour', '清包'], ['full', '全包']]), options]
}

function quoteGroups(lines, editable) {
  const groups = Map.groupBy(lines.map((line, index) => ({ line, index })), ({ line }) => line.room || '未分配房间')
  return [...groups].map(([room, entries]) => el('section', { className: 'quote-room' }, el('h3', {}, room),
    list(entries.map(({ line, index }) => {
      const quantity = line.quantity ? line.quantity + ' ' + line.unit + ' · ' + labelOf[line.source] : '待填工程量'
      const price = editable ? (line.price ? '¥' + line.price + ' / ' + line.unit : '待填单价') : money(line.unitCents) + ' / ' + line.unit
      return item(line.name, [quantity, price, labelOf[line.supply], line.note].filter(Boolean).join(' · '),
        editable ? action('编辑', () => editQuoteLine(index, line)) : el('span', { className: 'amount' }, money(line.totalCents)),
        editable && ['㎡', 'm'].includes(line.unit) ? action('取图纸量', () => setMeasuredLine(index)) : null,
        line.drawing ? action('查看图纸', showDrawing(line.drawing)) : null,
        editable ? action('移除', () => { loadDraft().lines.splice(index, 1); persistDraft(); render() }, 'quiet') : null)
    }), '还没有施工项')))
}

function versionDetails(version) {
  openDialog((version.purpose === 'budget' ? '预算参考' : '正式报价') + ' · 第 ' + version.version + ' 版',
    el('div', {}, el('p', { className: 'total' }, money(version.totalCents)),
      ...quoteGroups(version.lines, false),
      ...[['scope', '包含范围'], ['exclusions', '不包含'], ['estimateTerms', '暂估与结算'], ['paymentTerms', '付款约定'],
        ['validUntil', '有效期至']].flatMap(([key, label]) => version[key] ? [el('p', {}, label + ' · ' + version[key])] : [])))
}

function quotePanel() {
  const draft = loadDraft()
  if (draft.draftOpen) return quoteDraft(draft)
  const versions = view.records.filter(row => row.kind === 'quote').reverse()
  const baseline = view.records.find(row => row.kind === 'baseline')
  return [
    el('section', { className: 'overview-panel' }, heading('报价', '查看聊天生成的报价，或在这里新建和编辑报价。',
      action(draft.lines.length ? '继续报价草稿' : '新建报价', () => {
        if (!draft.lines.length) return startDraft()
        draft.draftOpen = true
        persistDraft()
        render()
      }, 'primary'), action('查看项目图纸', showDrawing()), el('a', { href: '/' }, '去 DSH 聊天报价'))),
    section('报价版本', list(versions.map(row => item((row.purpose === 'budget' ? '预算参考' : '正式报价') + ' · 第 ' + row.version + ' 版',
      [money(row.totalCents), row.id === baseline?.quoteId ? '已设为签约依据' : '', row.created?.slice(0, 10)].filter(Boolean).join(' · '),
      action('查看明细', () => versionDetails(row)),
      el('a', { href: url('api/export', { project: view.project.id, quote: row.id }) }, '下载 Excel'),
      action('复制', () => startDraft(row.lines.map(line => ({ ...line, price: (line.unitCents / 100).toFixed(2) })),
        { tax: row.tax, scope: row.scope, exclusions: row.exclusions, estimateTerms: row.estimateTerms, paymentTerms: row.paymentTerms, validUntil: '' })),
      !baseline && row.purpose !== 'budget' ? action('设为签约依据', () => openDialog('确认签约依据',
        form(async fields => { await record({ kind: 'baseline', quoteId: row.id, note: fields.get('note') }); modal.close() },
          field('合同编号或确认依据', 'note', { required: true }), submit('确认签约依据')))) : null)), '还没有报价，点击「新建报价」开始')),
  ]
}

function quoteDraft(draft) {
  const title = heading(draft.step === 'review' ? '核对客户报价' : '报价草稿', '',
    draft.step === 'review' ? action('修改施工清单', () => { draft.step = 'lines'; persistDraft(); render() }) : null,
    action('返回报价', () => { draft.draftOpen = false; persistDraft(); render() }))
  if (draft.step === 'start') return [section(null, title, el('div', { className: 'paths' },
    action('从常用施工模板开始', () => chooseTemplate(), 'primary'),
    action('从图纸算量开始', () => chooseTemplate(true)),
    action('导入旧报价 Excel', () => importDialog(false)),
    action('手动添加施工项', () => { draft.step = 'lines'; persistDraft(); render(); editQuoteLine() })))]
  const incomplete = draft.lines.filter(line => !line.quantity || line.price === '').length
  const estimates = draft.lines.filter(line => line.source === 'estimate').length
  if (draft.step === 'review') {
    const summary = draft.preview
    const review = form(async fields => {
      const values = Object.fromEntries(fields)
      const purpose = values.purpose
      const id = view.project.id
      await record({ ...values, kind: 'quote', purpose, lines: draft.lines })
      drafts.delete(id)
      localStorage.removeItem('renovation-quote:' + id)
      render()
      report(purpose === 'formal' ? '正式报价已保存，可以下载客户版' : '预算参考已保存')
    }, select('用途', 'purpose', [['formal', '正式报价'], ['budget', '预算参考']]),
    select('报价口径', 'tax', [['included', '含税'], ['excluded', '未含税']], draft.tax),
    field('有效期至（可选）', 'validUntil', { type: 'date', value: draft.validUntil ?? '' }),
    field('包含范围', 'scope', { value: draft.scope ?? '' }), field('不包含的项目', 'exclusions', { value: draft.exclusions ?? '' }),
    field(estimates ? '暂估项目如何复量结算' : '暂估说明（可选）', 'estimateTerms', { value: draft.estimateTerms ?? '' }),
    field('付款约定（可选）', 'paymentTerms', { value: draft.paymentTerms ?? '' }), submit('保存报价版本'))
    review.addEventListener('input', () => {
      for (const [key, val] of new FormData(review)) if (key !== 'purpose') draft[key] = val
      persistDraft()
    })
    return [section(null, title, el('p', { className: 'total' }, money(summary.totalCents)),
      estimates ? el('p', { className: 'muted' }, estimates + ' 项暂估。正式报价需说明复量结算方式。') : null, review),
    ...quoteGroups(summary.lines, false)]
  }
  const missingItems = draft.lines.filter(line => !line.quantity || line.price === '').map(line => line.name)
  const priced = draft.lines.filter(line => line.quantity && line.price !== '')
  const estimateTotal = priced.reduce((sum, line) => sum + Math.round(Number(line.quantity) * Number(line.price) * 100), 0)
  return [section(null, title, el('p', {}, '已填项目小计 ', el('strong', { className: 'amount' }, money(estimateTotal))),
    el('p', { className: 'muted' }, incomplete ? '待补数量或单价：' + missingItems.join('、') : '数量和单价已填齐',
      estimates ? ' · ' + estimates + ' 项暂估' : ''),
    el('div', { className: 'actions' }, action('添加施工项', () => editQuoteLine()),
      action('导入团队价表', () => importDialog(true)), action('核对报价', async () => {
        if (incomplete) return report('请补齐待处理项目，或移除不在本次范围内的项目')
        draft.preview = await api('quote-preview', { project: view.project.id }, { lines: draft.lines })
        draft.step = 'review'
        persistDraft()
        render()
      }, 'primary'))), ...quoteGroups(draft.lines, true)]
}

const entryTypes = {
  receipt: ['收到款了', '业主首款、进度款或尾款'],
  cost: ['付了钱', '材料、人工或其他项目费用'],
  payable: ['先欠着', '货到了或活做了，稍后结款'],
  advance: ['有人垫了', '工长或团队成员先替项目付款'],
}

function chooseEntry() {
  openDialog('记一笔', el('div', { className: 'paths' }, ...Object.entries(entryTypes).map(([key, [label, detail]]) => {
    const control = action(label, () => entryDialog(key))
    control.append(el('small', {}, detail))
    return control
  })))
}

function accountSelect() {
  const accounts = view.accounts
  const recent = localStorage.getItem('renovation-recent-account')
  return select('收付款账户', 'accountId', [['', '暂不指定'], ...accounts.map(account => [account.id, account.name])],
    accounts.some(account => account.id === recent) ? recent : '')
}

function entryDialog(mode, linked) {
  const kind = ['payable', 'advance'].includes(mode) ? 'cost' : mode
  const headingText = mode === 'payment' ? (linked.advancedBy ? '记报销' : '记付款') : entryTypes[mode][0]
  const dateField = field('发生日期', 'date', { type: 'date', value: today(), required: true })
  const valueField = field(mode === 'payment' && linked.advancedBy ? '报销金额（元）' : mode === 'receipt' ? '收到金额（元）' : '费用金额（元）',
    'amount', { inputMode: 'decimal', placeholder: '0.00', value: linked ? (linked.due / 100).toFixed(2) : '', required: true })
  const label = field(mode === 'receipt' ? '收款事项' : '费用事项', 'label',
    { value: linked ? (mode === 'payment' && linked.advancedBy ? '报销 · ' : '') + linked.label : '',
      placeholder: mode === 'receipt' ? '如 业主首期款' : '如 购买瓷砖', required: true })
  const paid = mode === 'cost' ? field('这次实际付了多少（可选）', 'paidAmount',
    { inputMode: 'decimal', placeholder: '留空表示全额付清' }) : null
  const installment = mode === 'receipt' && !linked ? select('对应期款（可选）', 'installmentId',
    [['', '暂不匹配'], ...installmentBalances().map(row => [row.id, row.label + ' · ' + money(row.due)])]) : null
  const attachment = field('上传凭据（可选）', 'attachment',
    { type: 'file', multiple: true, accept: '.png,.jpg,.jpeg,.webp,.pdf,.xml,.ofd' })
  const receiptControls = el('details', { className: 'support' }, el('summary', {}, '添加凭据或识别图片'),
    attachment, action('识别首张图片', async () => {
      const image = attachment.lastChild.files[0]
      if (!image) return report('请先选择一张凭据图片')
      report('正在识别凭据…')
      const extracted = await api('receipt-draft', { project: view.project.id }, image)
      for (const field of [label, valueField, dateField]) {
        const input = field.lastChild
        if (extracted[input.name]) input.value = extracted[input.name]
      }
      report(Object.values(extracted).some(Boolean) ? '识别结果已填入，请先核对' : '没有识别到明确字段，请手填')
    }))
  const account = ['receipt', 'cost', 'payment'].includes(mode) ? accountSelect() : null
  const entry = form(async fields => {
    const { attachment: _attachment, ...input } = Object.fromEntries(fields)
    input.kind = kind
    if (mode === 'cost') input.paidAmount ||= input.amount
    if (mode === 'payment') input.costId = linked.id
    if (mode === 'receipt' && linked) input.installmentId = linked.id
    const files = fields.getAll('attachment').filter(file => file.size)
    if (files.length > 10) return report('每笔记录最多添加 10 份凭据')
    input.fileIds = []
    for (const file of files) {
      const saved = await api('file', { project: view.project.id, name: file.name }, file)
      if (saved.duplicate && view.records.some(row => row.fileIds?.includes(saved.id)) &&
        !window.confirm('这份凭据已关联其他记录，仍要使用吗？')) return
      input.fileIds.push(saved.id)
    }
    if (input.accountId) localStorage.setItem('renovation-recent-account', input.accountId)
    await record(input)
    modal.close()
  }, valueField, label, paid, account, installment,
  mode === 'advance' ? field('谁垫付了这笔钱', 'advancedBy', { placeholder: '如 张工', required: true }) : null,
  mode === 'payable' ? field('预计付款日（可选）', 'dueDate', { type: 'date' }) : null,
  dateField, receiptControls, submit(headingText))
  entry.classList.add('entry-form')
  openDialog(headingText, entry)
}

function recordDialog(title, kind, fields, extra = {}) {
  openDialog(title, form(async values => {
    await record({ ...Object.fromEntries(values), kind, ...extra })
    modal.close()
  }, ...fields, submit(title)))
}

function amountField() {
  return field('金额（元）', 'amount', { inputMode: 'decimal', required: true })
}

function ledgerPanel() {
  const baseline = view.records.find(row => row.kind === 'baseline')
  const changes = view.records.filter(row => row.kind === 'change')
  const confirmed = new Set(view.records.filter(row => row.kind === 'confirm-change').map(row => row.changeId))
  return [
    el('section', { className: 'overview-panel' }, heading('项目账', view.project.name, action('记一笔', chooseEntry, 'primary')),
      metrics([['待收', view.totals.outstanding], ['待付及报销', view.totals.payable], ['已发生成本', view.totals.cost], ['已收', view.totals.received]]),
      view.totals.overpayment ? el('p', { className: 'muted' }, '超收 ' + money(view.totals.overpayment)) : null),
    el('div', { className: 'subnav', role: 'group', 'aria-label': '账目查看方式' }, ...[['todo', '待处理'], ['history', '收支明细'], ['terms', '合同与增减项']].map(([key, label]) => {
      const control = action(label, () => { ledgerTab = key; render() })
      control.setAttribute('aria-pressed', String(ledgerTab === key))
      return control
    })),
    ...(ledgerTab === 'todo' ? [
      todoPanel(),
      section('分期收款', action('添加收款计划', () => recordDialog('添加收款计划', 'installment',
        [field('期款名称', 'label', { required: true }), amountField(), field('到期日', 'date', { type: 'date', required: true })]))),
    ] : ledgerTab === 'history' ? [section('收支明细', history(),
      el('a', { href: url('api/export', { project: view.project.id }) }, '下载项目账 Excel'))] : [
      section('结算依据', baseline ? el('p', {}, baseline.note) :
        action('登记签约金额', () => recordDialog('登记签约金额', 'baseline', [
          amountField(), field('合同编号或确认依据', 'note', { required: true }),
        ])),
      baseline ? el('a', { href: url('api/export', { project: view.project.id, settlement: '1' }) }, '下载客户结算单') : null),
      section('增减项', list(changes.map(row => item(row.label, money(row.cents) + (confirmed.has(row.id) ? ' · 已确认' : ' · 待确认'),
        confirmed.has(row.id) ? null : action('确认变更', () => recordDialog('确认增减项', 'confirm-change',
          [field('双方确认依据', 'note', { required: true })], { changeId: row.id })))), '暂无增减项'),
        baseline ? action('登记增减项', () => recordDialog('登记增减项', 'change', [
          field('变更内容', 'label', { required: true }), field('金额（元，减项填负数）', 'amount', { inputMode: 'decimal', required: true }),
        ])) : el('p', { className: 'muted' }, '登记签约金额后，可以记录项目增减项')),
    ]),
  ]
}

function accountPanel() {
  const { accounts, transfers } = accountState
  const accountOptions = accounts.map(row => [row.id, row.name])
  const add = action('添加账户', () => openDialog('添加账户', form(async values => {
    accountState = await api('accounts', {}, Object.fromEntries(values))
    view.accounts = accountState.accounts
    modal.close()
    render()
  }, field('账户名称', 'name', { placeholder: '如 微信、现金、公司银行卡', required: true }),
  field('期初金额（可选）', 'opening', { inputMode: 'decimal' }), submit('保存账户'))), 'primary')
  const transfer = accounts.length > 1 ? action('账户转账', () => {
    const id = crypto.randomUUID()
    openDialog('账户转账', form(async values => {
      accountState = await api('transfer', {}, { ...Object.fromEntries(values), id })
      modal.close()
      render()
    }, select('转出账户', 'source', accountOptions), select('转入账户', 'target', accountOptions, accounts[1].id),
    amountField(), field('转账日期', 'date', { type: 'date', value: today(), required: true }), submit('保存转账')))
  }) : null
  return [
    el('section', { className: 'overview-panel' }, heading('资金账户', '账户汇总整个团队已登记的资金流水。', add, transfer)),
    section('账户列表', list(accounts.map(row => item(row.name,
      row.balance === null ? '未设期初金额，仅统计已录流水' : '账面余额',
      el('span', { className: 'amount' }, money(row.balance ?? row.movement)))), '添加微信、现金或银行卡账户后，记账时就能直接选用')),
    section('账户转账', list(transfers.map(row => item(
      accounts.find(account => account.id === row.source)?.name + ' → ' + accounts.find(account => account.id === row.target)?.name,
      row.date, el('span', { className: 'amount' }, money(row.cents)))), '暂无账户间转账')),
  ]
}

function render() {
  const chooser = projects.length ? select('当前项目', 'project', projects.map(project => [project.id, project.name]), view?.project.id) : null
  chooser?.addEventListener('change', run(async () => setProject(chooser.lastChild.value)))
  const createProject = () => openDialog('新建项目', form(async fields => {
    const created = await api('projects', {}, Object.fromEntries(fields))
    projects.unshift(created)
    await setProject(created.id)
    modal.close()
  }, field('项目名称', 'name', { required: true, placeholder: '如 青禾苑 3 栋' }), field('城市（可选）', 'city'), submit('创建项目')))
  const newProject = action('新建项目', createProject)
  const masthead = el('header', { className: 'masthead' }, el('h1', {}, '装修项目工作台'), el('div', { className: 'actions' }, chooser, newProject))
  const nav = view ? el('nav', { 'aria-label': '工作台导航' }, ...[['overview', '项目概览'], ['quote', '报价'], ['ledger', '项目账'], ['accounts', '账户']].map(([key, label]) => {
    const control = action(label, async () => {
      if (key === 'accounts') accountState = await api('accounts')
      navigate(key)
    })
    if (key === tab) control.setAttribute('aria-current', 'page')
    return control
  })) : null
  const panels = view ? { overview, quote: quotePanel, ledger: ledgerPanel, accounts: accountPanel }[tab]() :
    [section('开始管理第一个装修项目', el('p', { className: 'muted' }, '可以先做一份报价，也可以直接记一笔收支。'),
      action('创建项目', createProject, 'primary'))]
  app.replaceChildren(masthead, nav ?? '', el('p', { className: 'notice', role: 'status' }, status), ...panels)
}

async function init() {
  try {
    projects = await api('projects')
    const query = new URLSearchParams(location.search)
    const requestedProject = query.get('project')
    const saved = requestedProject || localStorage.getItem('renovation-project')
    if (projects.length) {
      await setProject(projects.find(project => project.id === saved)?.id ?? projects[0].id)
      if (requestedProject === view.project.id && query.has('quote')) {
        const version = view.records.find(row => row.kind === 'quote' && row.id === query.get('quote'))
        navigate('quote')
        if (version) versionDetails(version)
        else report('未找到这份报价')
      }
    } else render()
  } catch (error) {
    app.replaceChildren(el('p', { role: 'alert' }, errors[error.message] ?? errors.operation_failed), button('重试', init))
  }
}
await init()
