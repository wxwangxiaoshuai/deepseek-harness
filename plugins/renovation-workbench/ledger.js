/** Project records, quote snapshots and reconciliation for the renovation workbench. */
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

export class InputError extends Error {
  constructor(code, options) {
    super(code, options)
    this.code = code
  }
}

export function requiredText(value, max = 180) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new InputError('invalid_input')
  return value.trim()
}

function optionalText(value, max) {
  return value == null || value === '' ? '' : requiredText(value, max)
}

export function amount(value, signed = false) {
  if (typeof value !== 'string' || !/^-?\d{1,9}(\.\d{1,2})?$/.test(value)) throw new InputError('invalid_amount')
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.')
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  const result = value.startsWith('-') ? -cents : cents
  if (!signed && result < 0) throw new InputError('invalid_amount')
  return result
}

function choice(value, allowed) {
  if (!allowed.includes(value)) throw new InputError('invalid_input')
  return value
}

function date(value) {
  const raw = requiredText(value, 10)
  const parsed = Date.parse(raw)
  if (!/^\d{4}-\d\d-\d\d$/.test(raw) || !Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== raw) {
    throw new InputError('invalid_date')
  }
  return raw
}

export function quoteLine(line) {
  if (!line || typeof line !== 'object') throw new InputError('invalid_input')
  const quantity = requiredText(line.quantity, 14)
  if (!/^\d{1,7}(\.\d{1,4})?$/.test(quantity) || Number(quantity) <= 0) throw new InputError('invalid_quantity')
  const [whole, fraction = ''] = quantity.split('.')
  const scaled = BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, '0'))
  const unitCents = amount(line.price)
  const total = (scaled * BigInt(unitCents) + 5_000n) / 10_000n
  if (total > 100_000_000_000n) throw new InputError('invalid_amount')
  return {
    name: requiredText(line.name), room: optionalText(line.room, 80), quantity,
    unit: choice(line.unit, ['㎡', 'm', '个', '点', '项', '套']),
    supply: choice(line.supply, ['owner', 'team', 'labour']),
    source: choice(line.source, ['drawing', 'manual', 'estimate']),
    note: optionalText(line.note, 500), unitCents, totalCents: Number(total),
    ...(line.source === 'drawing' && line.drawing ? { drawing: line.drawing } : {}),
  }
}

const SCHEMA_VERSION = 2

export class Ledger {
  constructor(path) {
    this.db = new DatabaseSync(path)
    try {
      this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; BEGIN IMMEDIATE')
      const { user_version: schema } = this.db.prepare('PRAGMA user_version').get()
      if (schema > SCHEMA_VERSION) throw new Error('Unsupported renovation project database version ' + schema)
      if (schema === 0) this.db.exec(`
      CREATE TABLE IF NOT EXISTS price_catalog (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1), data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, city TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records (
        project TEXT NOT NULL REFERENCES projects(id), id TEXT NOT NULL,
        kind TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (project, id)
      );
      CREATE TABLE IF NOT EXISTS files (
        project TEXT NOT NULL REFERENCES projects(id), id TEXT NOT NULL,
        name TEXT NOT NULL, digest TEXT NOT NULL, content BLOB NOT NULL, PRIMARY KEY (project, id),
        UNIQUE (project, digest)
      );
      `)
      if (schema < 2) this.db.exec(`
        CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, opening INTEGER);
        CREATE TABLE transfers (
          id TEXT PRIMARY KEY, source TEXT NOT NULL REFERENCES accounts(id),
          target TEXT NOT NULL REFERENCES accounts(id), cents INTEGER NOT NULL, date TEXT NOT NULL
        );
        PRAGMA user_version = ${SCHEMA_VERSION};
      `)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  prices() {
    const row = this.db.prepare('SELECT data FROM price_catalog WHERE singleton = 1').get()
    return row ? JSON.parse(row.data) : []
  }

  savePrices(lines) {
    this.db.prepare(`INSERT INTO price_catalog VALUES (1, ?)
      ON CONFLICT (singleton) DO UPDATE SET data = excluded.data`).run(JSON.stringify(lines))
  }

  accounts() {
    const accounts = this.db.prepare('SELECT * FROM accounts ORDER BY rowid').all()
    const movement = new Map(accounts.map(account => [account.id, 0]))
    const move = (id, cents) => { if (movement.has(id)) movement.set(id, movement.get(id) + cents) }
    for (const row of this.db.prepare("SELECT kind, data FROM records WHERE kind IN ('receipt', 'cost', 'payment')").iterate()) {
      const record = JSON.parse(row.data)
      move(record.accountId, row.kind === 'receipt' ? record.cents : -(row.kind === 'cost' ? record.paidCents ?? 0 : record.cents))
    }
    const transfers = this.db.prepare('SELECT * FROM transfers ORDER BY rowid DESC').all()
    for (const transfer of transfers) {
      move(transfer.source, -transfer.cents)
      move(transfer.target, transfer.cents)
    }
    return { accounts: accounts.map(account => ({ ...account, movement: movement.get(account.id),
      balance: account.opening === null ? null : account.opening + movement.get(account.id) })), transfers }
  }

  addAccount(input) {
    const name = requiredText(input.name, 60)
    const opening = input.opening ? amount(input.opening, true) : null
    this.db.prepare('INSERT INTO accounts VALUES (?, ?, ?) ON CONFLICT(name) DO NOTHING').run(randomUUID(), name, opening)
    return this.accounts()
  }

  accountId(value) {
    const id = optionalText(value, 80)
    if (id && !this.db.prepare('SELECT id FROM accounts WHERE id = ?').get(id)) throw new InputError('account_missing')
    return id
  }

  transfer(input) {
    const id = requiredText(input.id, 80)
    const source = this.accountId(input.source)
    const target = this.accountId(input.target)
    const cents = amount(input.amount)
    const day = date(input.date)
    if (!source || !target || source === target || !cents) throw new InputError('invalid_transfer')
    const result = this.db.prepare('INSERT INTO transfers VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING').run(id, source, target, cents, day)
    if (!result.changes) {
      const record = this.db.prepare('SELECT * FROM transfers WHERE id = ?').get(id)
      if (record.source !== source || record.target !== target || record.cents !== cents || record.date !== day) {
        throw new InputError('operation_conflict')
      }
    }
    return this.accounts()
  }

  list() {
    return this.db.prepare('SELECT * FROM projects ORDER BY rowid DESC').all()
  }

  preview(input) {
    if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > 500) throw new InputError('invalid_quote')
    const lines = input.lines.map(quoteLine)
    return { lines, totalCents: lines.reduce((sum, line) => sum + line.totalCents, 0) }
  }

  project(id) {
    const project = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id)
    if (!project) throw new InputError('project_missing')
    return project
  }

  create(input) {
    const project = { id: randomUUID(), name: requiredText(input.name), city: optionalText(input.city, 80) }
    this.db.prepare('INSERT INTO projects VALUES (?, ?, ?)').run(project.id, project.name, project.city)
    return project
  }

  saveChatQuote(sessionId, operationId, input, drawings) {
    const legacyProject = createHash('sha256').update('renovation-chat:' + sessionId).digest('hex')
    const quoteId = createHash('sha256').update(JSON.stringify([sessionId, operationId])).digest('hex')
    const fingerprint = JSON.stringify(input)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const earlier = this.db.prepare(`SELECT project, id, data FROM records WHERE kind = 'quote'
        AND (id = ? OR (project = ? AND id = ?)) LIMIT 1`).get(quoteId, legacyProject, operationId)
      if (earlier) {
        const { fingerprint: original, ...quote } = JSON.parse(earlier.data)
        if (original !== fingerprint) throw new InputError('operation_conflict')
        this.db.exec('COMMIT')
        return { projectId: earlier.project, quote: { ...quote, id: earlier.id } }
      }
      const name = requiredText(input.projectName)
      const city = optionalText(input.city, 80)
      let id
      if (input.projectId !== undefined) {
        const project = this.project(requiredText(input.projectId, 80))
        if (input.createProject || project.name !== name || (city && city !== project.city)) {
          throw new InputError('project_selection_required')
        }
        id = project.id
      } else {
        if (!input.createProject && this.db.prepare('SELECT 1 FROM projects WHERE name = ?').get(name)) {
          throw new InputError('project_selection_required')
        }
        id = this.create({ name, city }).id
      }
      const records = this.records(id)
      const saved = new Map()
      for (const drawing of drawings.values()) {
        const digest = createHash('sha256').update(drawing.bytes).digest('hex')
        saved.set(drawing.ref.attachmentId, this.saveFile(id, drawing.ref.name, digest, drawing.bytes).id)
      }
      const lines = input.lines.map(line => line.drawing ? { ...line, drawing: {
        fileId: saved.get(line.drawing.attachmentId), shapeId: line.drawing.shapeId,
        scale: line.drawing.scale, metric: line.drawing.metric,
      } } : line)
      const quote = this.buildRecord(id, 'quote', { ...input, lines }, records)
      this.db.prepare('INSERT INTO records VALUES (?, ?, ?, ?)').run(id, quoteId, 'quote', JSON.stringify({ ...quote, fingerprint }))
      this.db.exec('COMMIT')
      return { projectId: id, quote: { id: quoteId, ...quote } }
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }

  records(id) {
    return this.db.prepare('SELECT id, kind, data FROM records WHERE project = ? ORDER BY rowid').all(id)
      .map(({ id, kind, data }) => ({ id, kind, ...JSON.parse(data) }))
  }

  view(id) {
    const project = this.project(id)
    const records = this.records(id)
    const byKind = kind => records.filter(record => record.kind === kind)
    const sum = (list, field) => list.reduce((total, record) => total + record[field], 0)
    const received = sum(byKind('receipt'), 'cents')
    const cost = sum(byKind('cost'), 'cents')
    const paid = sum(byKind('payment'), 'cents') + byKind('cost').reduce((total, entry) => total + (entry.paidCents ?? 0), 0)
    const confirmedIds = new Set(byKind('confirm-change').map(record => record.changeId))
    const changes = sum(byKind('change').filter(record => confirmedIds.has(record.id)), 'cents')
    const reference = byKind('baseline')[0]
    const quote = byKind('quote').find(row => row.id === reference?.quoteId)
    const agreed = reference ? (reference.cents ?? quote.totalCents) + changes : null
    const files = this.db.prepare('SELECT id, name FROM files WHERE project = ? ORDER BY rowid').all(id)
    return { project, records, files, prices: this.prices(), accounts: this.accounts().accounts, totals: { agreed, received, outstanding: agreed === null ? null : Math.max(0, agreed - received),
      overpayment: agreed === null ? null : Math.max(0, received - agreed), cost, paid, payable: cost - paid, margin: agreed === null ? null : agreed - cost } }
  }

  add(id, input) {
    this.project(id)
    const recordId = requiredText(input.id, 80)
    const kind = requiredText(input.kind, 24)
    const fingerprint = JSON.stringify(input)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const records = this.records(id)
      const earlier = records.find(record => record.id === recordId)
      if (earlier) {
        if (earlier.fingerprint !== fingerprint) throw new InputError('operation_conflict')
        this.db.exec('COMMIT')
        return this.publicView(id)
      }
      const data = this.buildRecord(id, kind, input, records)
      this.db.prepare('INSERT INTO records VALUES (?, ?, ?, ?)').run(id, recordId, kind, JSON.stringify({ ...data, fingerprint }))
      this.db.exec('COMMIT')
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
    return this.publicView(id)
  }

  publicView(id) {
    const view = this.view(id)
    return { ...view, records: view.records.map(({ fingerprint, ...record }) => record) }
  }

  buildRecord(project, kind, input, records) {
    const find = (kind, id) => records.find(record => record.kind === kind && record.id === id)
    const sumAgainst = (kind, field, id) => records.reduce((sum, row) => row.kind === kind && row[field] === id ? sum + row.cents : sum, 0)
    const baseline = records.find(record => record.kind === 'baseline')
    switch (kind) {
      case 'quote': {
        const prepared = this.preview(input)
        const purpose = input.purpose === undefined ? 'formal' : choice(input.purpose, ['formal', 'budget'])
        const terms = {
          scope: optionalText(input.scope, 500), exclusions: optionalText(input.exclusions, 500),
          estimateTerms: optionalText(input.estimateTerms, 500), paymentTerms: optionalText(input.paymentTerms, 500),
          validUntil: input.validUntil ? date(input.validUntil) : '',
        }
        if (input.purpose === 'formal' && prepared.lines.some(line => line.source === 'estimate') && !terms.estimateTerms) {
          throw new InputError('estimate_terms_required')
        }
        return { ...prepared, ...terms, purpose, tax: choice(input.tax, ['included', 'excluded']),
          version: records.filter(row => row.kind === 'quote').length + 1, created: new Date().toISOString() }
      }
      case 'baseline':
        if (baseline) throw new InputError('baseline_exists')
        if (input.quoteId) {
          const quote = find('quote', input.quoteId)
          if (!quote || quote.purpose === 'budget') throw new InputError('invalid_quote')
          return { quoteId: input.quoteId, note: requiredText(input.note, 500) }
        }
        return { cents: amount(input.amount), note: requiredText(input.note, 500) }
      case 'change': {
        const cents = amount(input.amount, true)
        if (!baseline || cents === 0) throw new InputError('invalid_change')
        return { label: requiredText(input.label), cents }
      }
      case 'confirm-change': {
        const change = find('change', input.changeId)
        if (!change || records.some(row => row.kind === 'confirm-change' && row.changeId === change.id)) {
          throw new InputError('invalid_change')
        }
        const agreed = this.view(project).totals.agreed
        if (agreed === null || agreed + change.cents < 0) throw new InputError('invalid_change')
        return { changeId: change.id, note: requiredText(input.note, 500) }
      }
      case 'installment': {
        const cents = amount(input.amount)
        if (cents === 0) throw new InputError('invalid_amount')
        return { label: requiredText(input.label), date: date(input.date), cents }
      }
      case 'receipt':
      case 'cost':
      case 'payment': {
        const cents = amount(input.amount)
        if (cents === 0) throw new InputError('invalid_amount')
        const attachments = input.fileIds ?? []
        if (!Array.isArray(attachments) || attachments.length > 10) throw new InputError('invalid_attachment')
        const fileIds = [...new Set(attachments.map(id => requiredText(id, 80)))]
        if (fileIds.some(id => !this.file(project, id))) throw new InputError('file_missing')
        const accountId = this.accountId(input.accountId)
        const common = { cents, date: date(input.date), label: requiredText(input.label), fileIds, ...(accountId ? { accountId } : {}) }
        if (kind === 'cost') {
          const advancedBy = optionalText(input.advancedBy, 100)
          const paidCents = input.paidAmount ? amount(input.paidAmount) : 0
          if (paidCents > cents || (advancedBy && paidCents > 0) || (accountId && !paidCents)) throw new InputError('invalid_payment')
          const dueDate = input.dueDate ? date(input.dueDate) : ''
          return { ...common, advancedBy, ...(paidCents ? { paidCents } : {}), ...(dueDate ? { dueDate } : {}) }
        }
        if (kind === 'receipt') {
          const installmentId = optionalText(input.installmentId, 80)
          if (installmentId && !find('installment', installmentId)) throw new InputError('installment_missing')
          return { ...common, installmentId }
        }
        const cost = find('cost', input.costId)
        if (!cost || cents + (cost.paidCents ?? 0) + sumAgainst('payment', 'costId', input.costId) > cost.cents) throw new InputError('invalid_payment')
        return { ...common, costId: cost.id }
      }
      default: throw new InputError('invalid_input')
    }
  }

  file(project, id) {
    return this.db.prepare('SELECT id, name, content FROM files WHERE project = ? AND id = ?').get(project, id)
  }

  saveFile(project, name, digest, content) {
    this.project(project)
    const id = randomUUID()
    const statement = this.db.prepare('INSERT INTO files VALUES (?, ?, ?, ?, ?) ON CONFLICT(project, digest) DO NOTHING')
    const { changes } = statement.run(project, id, requiredText(name), digest, content)
    const saved = changes ? id : this.db.prepare('SELECT id FROM files WHERE project = ? AND digest = ?').get(project, digest).id
    return { id: saved, duplicate: !changes }
  }

  close() {
    this.db.close()
  }
}
