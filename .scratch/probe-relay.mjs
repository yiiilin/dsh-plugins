// Send one HTTP request through a relay port and print what comes back.
//
// A raw socket rather than curl: the relay carries bytes in both directions, and when the
// answer is malformed curl refuses to show it ("Received HTTP/0.9 when not allowed"),
// which hides the very bytes that explain why.
import { connect } from 'node:net'

const port = Number(process.argv[2])
const socket = connect({ host: '127.0.0.1', port }, () => {
  // The federation header is what the far daemon checks; without it the answer is the
  // login page, which parses as neither JSON nor an error.
  socket.write('GET /admin/state HTTP/1.1\r\nHost: x\r\nx-dsh-federation: tunnel\r\nConnection: close\r\n\r\n')
})
const parts = []
socket.on('data', (piece) => parts.push(piece))
socket.on('error', (error) => {
  console.log(`connect error: ${error.message}`)
  process.exit(0)
})
const done = () => {
  const text = Buffer.concat(parts).toString('latin1')
  console.log(`bytes=${Buffer.concat(parts).length}`)
  console.log(`body=${JSON.stringify(text.slice(0, 160))}`)
  process.exit(0)
}
socket.on('end', done)
setTimeout(() => {
  console.log('timed out waiting for an answer')
  done()
}, 12_000)
