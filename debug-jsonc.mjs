import { stripJsonc } from './src/workspace-schema.ts'
const input1 = '{ "a": [1, 2,], "b": "x,}," , }'
console.log('IN1 :', input1)
console.log('OUT1:', JSON.stringify(stripJsonc(input1)))
const s = [
  '{ // drop me',
  '  "folders": ["/*not a comment*/", "// not a comment //"],',
  '  /* block',
  '     comment */',
  '  "x": 1, // trailing',
  '}',
].join('\n')
console.log('IN2 :', s)
console.log('OUT2:', JSON.stringify(stripJsonc(s)))
try {
  console.log('parsed2:', JSON.stringify(JSON.parse(stripJsonc(s))))
} catch (error) {
  console.log('parse2 error:', (error as Error).message)
}
