/** Isolated DXF parsing. The Host translates parse failures into workbench errors. */
import { parentPort, workerData } from 'node:worker_threads'
import { parseDxf } from './cad.js'

try {
  parentPort.postMessage({ drawing: parseDxf(workerData) })
} catch (error) {
  parentPort.postMessage({ code: error.code ?? 'invalid_cad' })
}
