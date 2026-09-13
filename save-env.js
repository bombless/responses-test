const keytar = require('keytar')


const SERVICE = 'responses-test';

const keys = [
  'KEY',
  'URL',
  'MODEL',
]

async function main () {
  await Promise.all(keys.map(key =>
    keytar.setPassword(SERVICE, key, process.env[key] ?? '')
  ))
  console.log(
    'done',
    'URL=', process.env.URL,
    'MODEL=', process.env.MODEL,
    'API=', process.env.API
  )
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
