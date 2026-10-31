#!/usr/bin/env node
// test-all.mjs —— 一把跑完全部离线测试套件
//
// 约定：文件名以 `-test.mjs` 结尾，或就是 `verify.mjs`。
// 每个套件自己打印 `N/N passed`，本脚本只做编排与汇总，不改任何一个套件的断言。
//
//   node test-all.mjs          全部跑一遍
//   node test-all.mjs path     只跑名字含 "path" 的套件
//
// 全部离线：不连 SakuraFrp、不需要访问密钥、不写任何用户目录。

import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const suiteDir = join(here, 'test')
const filter = process.argv[2] ?? ''

const suites = readdirSync(suiteDir)
  .filter((f) => f.endsWith('-test.mjs') || f === 'verify.mjs')
  .filter((f) => !filter || f.includes(filter))
  .sort()

if (suites.length === 0) {
  console.error(`没有匹配的套件${filter ? `（关键字：${filter}）` : ''}`)
  process.exit(1)
}

let passed = 0
let failed = 0
const failedNames = []

for (const file of suites) {
  const r = spawnSync(process.execPath, [join(suiteDir, file)], { encoding: 'utf8', timeout: 120_000 })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const m = out.match(/(\d+)\/(\d+) passed/)
  const [got, total] = m ? [Number(m[1]), Number(m[2])] : [0, 0]

  if (r.status === 0 && m && got === total) {
    passed += total
    console.log(`  ok   ${file.padEnd(26)} ${got}/${total}`)
  } else {
    failed += total - got || 1
    failedNames.push(file)
    console.log(`  FAIL ${file.padEnd(26)} ${got}/${total}`)
    const tail = out.trim().split('\n').slice(-6).join('\n')
    if (tail) console.log(tail.replace(/^/gm, '       '))
  }
}

const total = passed + failed
console.log(`\n${failed === 0 ? '全部通过' : '有失败'}：${passed}/${total} 项，${suites.length} 个套件`)
if (failedNames.length) {
  console.log(`失败套件：${failedNames.join(', ')}`)
  process.exit(1)
}
