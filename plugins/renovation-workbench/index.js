/** Cordis Host plugin for the authenticated renovation workspace. */
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { InputError, Ledger, requiredText } from './ledger.js'
import { CAD_LIMIT, drawingBytes, parseDrawing } from './cad.js'
import { registerChatTools } from './chat-tools.js'
import { extractReceipt } from './receipt.js'
import { exportLedger, exportQuote, exportSettlement, importQuote } from './workbook.js'

export const name = 'renovation-workbench'
export const inject = ['webServer', 'connection', 'dshHomePath', 'tools', 'attachments', 'systemPrompt']

const base = '/renovation-workbench'
const mime = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

function send(res, status, bytes, type = 'application/json; charset=utf-8', filename) {
  res.statusCode = status
  res.setHeader('content-type', type)
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
  if (filename) res.setHeader('content-disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(filename))
  res.end(bytes)
}

function json(res, status, value) {
  send(res, status, JSON.stringify(value))
}

async function body(req, limit) {
  const length = Number(req.headers['content-length'])
  if (Number.isFinite(length) && length > limit) {
    req.resume()
    throw new InputError('upload_too_large')
  }
  const chunks = []
  let size = 0
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > limit) {
      req.resume()
      throw new InputError('upload_too_large')
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function readJson(req) {
  const bytes = await body(req, 512 * 1024)
  let value
  try {
    value = JSON.parse(bytes.toString())
  } catch (error) {
    throw new InputError('invalid_input', { cause: error })
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('invalid_input')
  return value
}

async function validateDrawingLines(input, store, project, converter, signal) {
  if (input.kind !== 'quote' || !Array.isArray(input.lines) || input.lines.length > 500) return
  const drawings = new Map()
  for (const line of input.lines) {
    if (line?.source !== 'drawing') continue
    const fileId = requiredText(line.drawing?.fileId, 80)
    const shapeId = requiredText(line.drawing?.shapeId, 20)
    const scale = Number(line.drawing?.scale)
    const metric = line.drawing?.metric
    if (!Number.isFinite(scale) || scale <= 0 || !['area', 'length'].includes(metric)) throw new InputError('invalid_quantity')
    if (!drawings.has(fileId)) {
      const file = store.file(project, fileId)
      if (!file) throw new InputError('file_missing')
      drawings.set(fileId, await parseDrawing(await drawingBytes(Buffer.from(file.content), file.name, converter, signal), signal))
    }
    const shape = drawings.get(fileId).shapes.find(entry => entry.id === shapeId)
    const measured = metric === 'area' ? shape?.area : shape?.length
    const expected = measured == null ? null : measured * (metric === 'area' ? scale ** 2 : scale)
    if (!expected || !Number.isFinite(expected) || line.quantity !== expected.toFixed(4) ||
      line.unit !== (metric === 'area' ? '㎡' : 'm')) throw new InputError('invalid_quantity')
    line.drawing = { fileId, shapeId, scale, metric }
  }
}

async function handle(req, res, peer, store, config, signal) {
  const converter = config.dwgConverter
  if (peer?.principal.kind !== 'owner') return json(res, 403, { code: 'forbidden' })
  const { pathname, searchParams } = new URL(req.url, 'http://localhost')
  const subpath = pathname.slice(base.length)
  const project = searchParams.get('project')
  const fileId = searchParams.get('file')
  if (req.method === 'GET') {
    if (subpath === '') {
      res.setHeader('location', base + '/')
      return send(res, 308, '')
    }
    const staticFiles = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' }
    const asset = Object.hasOwn(staticFiles, subpath) ? staticFiles[subpath] : null
    if (asset) return send(res, 200, await readFile(new URL('./web/' + asset, import.meta.url)), mime[asset.split('.').at(-1)])
    switch (subpath) {
      case '/api/projects': return json(res, 200, store.list())
      case '/api/accounts': return json(res, 200, store.accounts())
      case '/api/project': return json(res, 200, store.publicView(requiredText(project, 80)))
      case '/api/file': {
        const file = store.file(requiredText(project, 80), requiredText(fileId, 80))
        if (!file) throw new InputError('file_missing')
        return send(res, 200, file.content, 'application/octet-stream', file.name)
      }
      case '/api/export': {
        const view = store.publicView(requiredText(project, 80))
        const quoteId = searchParams.get('quote')
        if (searchParams.get('settlement') === '1') {
          if (view.totals.agreed === null) throw new InputError('invalid_quote')
          return send(res, 200, await exportSettlement(view), mime.xlsx, '项目结算.xlsx')
        }
        if (!quoteId) return send(res, 200, await exportLedger(view), mime.xlsx, '项目账.xlsx')
        const quote = view.records.find(row => row.kind === 'quote' && row.id === quoteId)
        if (!quote) throw new InputError('invalid_quote')
        return send(res, 200, await exportQuote(view, quote), mime.xlsx, quote.purpose === 'budget' ? '装修预算参考.xlsx' : '装修报价.xlsx')
      }
      default: return json(res, 404, { code: 'not_found' })
    }
  }
  if (req.method !== 'POST' || req.headers['x-renovation-workbench'] !== '1') return json(res, 405, { code: 'method_not_allowed' })
  if (subpath === '/api/projects') return json(res, 201, store.create(await readJson(req)))
  if (subpath === '/api/accounts') return json(res, 201, store.addAccount(await readJson(req)))
  if (subpath === '/api/transfer') return json(res, 200, store.transfer(await readJson(req)))
  const id = requiredText(project, 80)
  store.project(id)
  switch (subpath) {
    case '/api/quote-preview':
      return json(res, 200, store.preview(await readJson(req)))
    case '/api/record': {
      const input = await readJson(req)
      await validateDrawingLines(input, store, id, converter, signal)
      return json(res, 200, store.add(id, input))
    }
    case '/api/drawing': {
      const filename = requiredText(searchParams.get('name'))
      const bytes = await body(req, CAD_LIMIT)
      const drawing = await parseDrawing(await drawingBytes(bytes, filename, converter, signal), signal)
      const file = store.saveFile(id, filename, createHash('sha256').update(bytes).digest('hex'), bytes)
      return json(res, 200, { ...drawing, fileId: file.id, duplicate: file.duplicate })
    }
    case '/api/read-drawing': {
      const file = store.file(id, requiredText(fileId, 80))
      if (!file) throw new InputError('file_missing')
      return json(res, 200, { ...await parseDrawing(await drawingBytes(Buffer.from(file.content), file.name, converter, signal), signal), fileId })
    }
    case '/api/receipt-draft':
      return json(res, 200, await extractReceipt(await body(req, CAD_LIMIT), config.ocrExecutable, signal))
    case '/api/import': {
      const pricesOnly = searchParams.get('prices') === '1'
      const result = await importQuote(await body(req, CAD_LIMIT), pricesOnly)
      if (pricesOnly && result.rows.length && !result.problems.length) store.savePrices(result.rows)
      return json(res, 200, result)
    }
    case '/api/file': {
      const filename = requiredText(searchParams.get('name'))
      if (!/\.(png|jpe?g|webp|pdf|xml|ofd)$/i.test(filename)) throw new InputError('invalid_attachment')
      const bytes = await body(req, CAD_LIMIT)
      if (!bytes.length) throw new InputError('invalid_attachment')
      return json(res, 201, store.saveFile(id, filename, createHash('sha256').update(bytes).digest('hex'), bytes))
    }
    default: return json(res, 404, { code: 'not_found' })
  }
}

/**
 * Mount the owner-only UI and durable project store for this Harness home.
 * @param ctx - Cordis context supplying the Web host and home path.
 * @param config - Optional absolute paths to dwg2dxf and tesseract.
 */
export function apply(ctx, config = {}) {
  for (const key of ['dwgConverter', 'ocrExecutable']) {
    if (config[key] !== undefined && (typeof config[key] !== 'string' || !isAbsolute(config[key]))) {
      throw new Error('renovation-workbench: ' + key + ' must be an absolute executable path')
    }
  }
  ctx.effect(() => {
    const dir = ctx.dshHomePath('renovation-workbench')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const store = new Ledger(join(dir, 'projects.sqlite'))
    const controller = new AbortController()
    const pending = new Set()
    let unregister
    let unregisterTools
    try {
      unregisterTools = registerChatTools(ctx, store, config, (run, signal) => {
        const operation = run(AbortSignal.any([controller.signal, signal])).finally(() => pending.delete(operation))
        pending.add(operation)
        return operation
      })
      unregister = ctx.webServer.register({
        kind: 'prefix', path: base, auth: 'required',
        handler(req, res, peer) {
          // Earlier Web carriers leave authentication of custom routes to the handler.
          if (!peer) {
            const admission = ctx.connection.admit(req)
            if ('rejection' in admission) return json(res, admission.rejection, { code: 'forbidden' })
            peer = admission.peer
          }
          const disconnect = new AbortController()
          const abort = () => disconnect.abort()
          res.once('close', abort)
          const stopRead = () => { if (!req.complete) req.destroy() }
          controller.signal.addEventListener('abort', stopRead, { once: true })
          const operation = handle(req, res, peer, store, config, AbortSignal.any([
            controller.signal, disconnect.signal, ...(peer?.signal ? [peer.signal] : []),
          ])).catch(error => {
            if (res.destroyed) return
            if (error instanceof InputError) {
              json(res, 400, { code: error.code })
              return
            }
            ctx.logger.warn('Renovation workbench operation failed: %s', error.name)
            json(res, 500, { code: 'operation_failed' })
          }).finally(() => {
            pending.delete(operation)
            res.off('close', abort)
            controller.signal.removeEventListener('abort', stopRead)
          })
          pending.add(operation)
          return operation
        },
      })
    } catch (error) {
      unregisterTools?.()
      store.close()
      throw error
    }
    return async () => {
      unregister()
      unregisterTools()
      controller.abort()
      await Promise.allSettled(pending)
      store.close()
    }
  })
}
