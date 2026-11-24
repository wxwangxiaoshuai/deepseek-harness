/** Supported 2D CAD measurements and locally configured DWG conversion. */
import { execFile } from 'node:child_process'
import { mkdtemp, rm, stat, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import { Worker } from 'node:worker_threads'
import DxfParser from 'dxf-parser'
import { InputError } from './ledger.js'

export const CAD_LIMIT = 5 * 1024 * 1024
const CONVERTED_DXF_LIMIT = 32 * 1024 * 1024

function decodeDxf(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    const prefix = new TextDecoder('latin1').decode(bytes.subarray(0, 64 * 1024))
    const page = prefix.match(/\$DWGCODEPAGE[ \t]*\r?\n[ \t]*3[ \t]*\r?\n[ \t]*([^\r\n]+)/)?.[1]?.trim().toUpperCase()
    const encoding = { ANSI_936: 'gbk', ANSI_950: 'big5', ANSI_1252: 'windows-1252' }[page]
    if (!encoding) throw new InputError('cad_encoding_unsupported', { cause: error })
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(bytes)
    } catch (cause) {
      throw new InputError('cad_encoding_unsupported', { cause })
    }
  }
}

function point(vertex) {
  return Number.isFinite(vertex.x) && Number.isFinite(vertex.y) &&
    (vertex.z == null || vertex.z === 0) ? [vertex.x, vertex.y] : null
}

function shapeFrom(entity) {
  if (!['LINE', 'LWPOLYLINE', 'POLYLINE'].includes(entity.type) || entity.is3dPolyline ||
    entity.is3dPolygonMesh || entity.isPolyfaceMesh || entity.vertices?.some(vertex => vertex.bulge) ||
    entity.extrusionDirectionX || entity.extrusionDirectionY ||
    (entity.extrusionDirectionZ != null && entity.extrusionDirectionZ !== 1)) return null
  const points = (entity.vertices ?? []).map(point)
  if (points.length < 2 || points.some(vertex => !vertex)) return null
  const first = points[0]
  const last = points.at(-1)
  const repeated = points.length > 2 && first[0] === last[0] && first[1] === last[1]
  if (repeated) points.pop()
  return { layer: entity.layer ?? '0', points, closed: Boolean(entity.shape) || repeated }
}

function cross(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

function overlaps(a, b, c, d) {
  for (let axis = 0; axis < 2; axis++) {
    if (Math.max(a[axis], b[axis]) < Math.min(c[axis], d[axis]) ||
      Math.max(c[axis], d[axis]) < Math.min(a[axis], b[axis])) return false
  }
  return Math.sign(cross(a, b, c)) * Math.sign(cross(a, b, d)) <= 0 &&
    Math.sign(cross(c, d, a)) * Math.sign(cross(c, d, b)) <= 0
}

function simpleBoundary(points) {
  if (points.length < 3 || points.length > 512) return false
  for (let edge = 0; edge < points.length - 2; edge++) {
    for (let other = edge + 2; other < points.length; other++) {
      if (edge === 0 && other === points.length - 1) continue
      if (overlaps(points[edge], points[edge + 1], points[other], points[(other + 1) % points.length])) return false
    }
  }
  return true
}

export function measure(shape) {
  const origin = shape.points[0]
  let length = 0
  let area = 0
  for (let index = 1; index < shape.points.length; index++) {
    const [ax, ay] = shape.points[index - 1]
    const [bx, by] = shape.points[index]
    length += Math.hypot(bx - ax, by - ay)
    area += (ax - origin[0]) * (by - origin[1]) - (bx - origin[0]) * (ay - origin[1])
  }
  if (shape.closed) {
    const last = shape.points.at(-1)
    length += Math.hypot(last[0] - origin[0], last[1] - origin[1])
  }
  return { length, area: shape.closed && simpleBoundary(shape.points) && area !== 0 ? Math.abs(area / 2) : null }
}

export function parseDxf(bytes) {
  if (bytes.byteLength > CONVERTED_DXF_LIMIT) throw new InputError('converted_drawing_too_large')
  const source = decodeDxf(bytes)
  if (!/^\s*0\s*\r?\n\s*SECTION\b/m.test(source) || !/\r?\n\s*0\s*\r?\n\s*EOF\s*$/i.test(source)) {
    throw new InputError('invalid_cad')
  }
  let drawing
  try {
    drawing = new DxfParser().parseSync(source)
  } catch (error) {
    throw new InputError('invalid_cad', { cause: error })
  }
  const entities = drawing?.entities ?? []
  if (entities.length > 20_000) throw new InputError('drawing_too_large')
  const shapes = []
  let unsupported = 0
  let vertices = 0
  for (const entity of entities) {
    if (entity.inPaperSpace) continue
    const shape = shapeFrom(entity)
    if (!shape) {
      unsupported++
      continue
    }
    const metrics = measure(shape)
    if (!Number.isFinite(metrics.length) || metrics.length <= 0 || (metrics.area !== null && !Number.isFinite(metrics.area))) {
      unsupported++
      continue
    }
    vertices += shape.points.length
    if (vertices > 40_000) throw new InputError('drawing_too_large')
    shapes.push({ id: String(shapes.length + 1), ...shape, ...metrics })
  }
  if (!shapes.length) throw new InputError('no_geometry')
  const units = { 1: 0.0254, 2: 0.3048, 4: 0.001, 5: 0.01, 6: 1 }
  return { shapes, unsupported, unit: drawing.header?.$INSUNITS ?? 0, metresPerUnit: units[drawing.header?.$INSUNITS] ?? null }
}

export async function drawingBytes(bytes, name, converter, signal) {
  if (bytes.length > CAD_LIMIT) throw new InputError('drawing_too_large')
  if (/\.dxf$/i.test(name)) return bytes
  if (!/\.dwg$/i.test(name) || !/^AC10\d\d/.test(bytes.subarray(0, 6).toString('ascii'))) throw new InputError('invalid_cad')
  if (typeof converter !== 'string' || !isAbsolute(converter)) throw new InputError('dwg_converter_missing')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-renovation-'))
  try {
    const input = join(dir, 'drawing.dwg')
    const output = join(dir, 'drawing.dxf')
    await writeFile(input, bytes, { mode: 0o600 })
    await promisify(execFile)(converter, ['-o', output, input], {
      cwd: dir, env: {}, signal, timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024, windowsHide: true,
    })
    if ((await stat(output)).size > CONVERTED_DXF_LIMIT) throw new InputError('converted_drawing_too_large')
    return await readFile(output)
  } catch (error) {
    if (error instanceof InputError) throw error
    throw new InputError('dwg_conversion_failed', { cause: error })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export function parseDrawing(bytes, signal) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./cad-worker.js', import.meta.url), {
      workerData: bytes, resourceLimits: { maxOldGenerationSizeMb: 192 },
    })
    let settled = false
    const finish = (error, drawing) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      void worker.terminate().then(() => error ? reject(error) : resolve(drawing), reject)
    }
    const abort = () => finish(signal.reason)
    const timer = setTimeout(() => finish(new InputError('drawing_too_large')), 10_000)
    signal?.addEventListener('abort', abort, { once: true })
    worker.once('error', error => finish(new InputError('invalid_cad', { cause: error })))
    worker.once('exit', () => finish(new InputError('invalid_cad')))
    worker.once('message', result => result.code ? finish(new InputError(result.code)) : finish(null, result.drawing))
  })
}
