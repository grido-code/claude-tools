import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Snap } from '../types'

const PANE = 'session-panel'
// 기록 폴더. PC(윈도우)에서 이 폴더가 있을 때만 기록한다.
// 클라우드 세션처럼 D:\클로드 가 없는 곳에서는 아무것도 쓰지 않는다.
const ROOT = 'D:/클로드'
// 기록은 도구 폴더 밖에 둔다 (GitHub에 올릴 때 섞이지 않게)
const LOG_DIR = `${ROOT}/기록/session-panel`

// Change the tag when a value's fields change: a reload declines what an
// earlier version stored.
const snap = atom({ plugin: 'session-panel', key: 'snap' } as const, null as Snap | null, {
  shape: 'snap-2',
})
const hist = atom({ plugin: 'session-panel', key: 'hist' } as const, [] as number[], {
  shape: 'hist-1',
})

// ---------- 그리기 도우미 ----------
const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)))
const clamp = (p: number) => Math.min(100, Math.max(0, p))
const bar = (pct: number, width: number) => {
  const w = Math.max(5, width)
  const on = Math.round((clamp(pct) / 100) * w)
  return '█'.repeat(on) + '░'.repeat(w - on)
}
const SPARK = '▁▂▃▄▅▆▇█'
const spark = (values: number[], width: number) =>
  values
    .slice(-Math.max(5, width))
    .map(v => SPARK[Math.min(7, Math.floor((clamp(v) / 100) * 8))])
    .join('')
const tone = (pct: number) => (pct >= 85 ? 'error' : pct >= 60 ? 'warning' : 'success')

// ---------- 이번 턴 동안 모으는 것 (모듈 변수: 다시 로드되면 비워짐) ----------
let tools = new Map<string, number>()
let mcps = new Map<string, number>()
let skillsUsed = new Map<string, number>()
let compacted = false
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1)
const joinCounts = (m: Map<string, number>) => [...m.entries()].map(([k, n]) => `${k}:${n}`).join('; ')

// 기록 쓰기는 한 번에 하나씩 (메인·서브에이전트 턴이 겹쳐도 줄이 사라지지 않게)
let queue: Promise<unknown> = Promise.resolve()

// "summary"는 로컬 추정이라 요청을 보내지 않는다: 모델 사용량이 들지 않음.
const readUsage = async ($: any) => {
  const u = await $.session.usage({ breakdown: 'summary' })
  const b = u.context.breakdown
  const byServer = new Map<string, { tokens: number; tools: number; loaded: number }>()
  for (const t of b?.mcpTools ?? []) {
    const s = byServer.get(t.serverName) ?? { tokens: 0, tools: 0, loaded: 0 }
    s.tools += 1
    if (t.isLoaded) {
      s.loaded += 1
      s.tokens += t.tokens
    }
    byServer.set(t.serverName, s)
  }
  const next: Snap = {
    at: Date.now(),
    model: b?.model,
    percent: u.context.percent,
    tokens: u.context.tokens,
    window: u.context.window,
    cats: (b?.categories ?? []).map((c: any) => ({ name: c.name, tokens: c.tokens, kind: c.kind })),
    mcp: [...byServer.entries()].map(([server, s]) => ({ server, ...s })).sort((a, z) => z.tokens - a.tokens),
    skills: b?.skills && {
      total: b.skills.totalSkills,
      included: b.skills.includedSkills,
      tokens: b.skills.tokens,
      top: [...b.skills.skillFrontmatter]
        .sort((a: any, z: any) => z.tokens - a.tokens)
        .slice(0, 8)
        .map((s: any) => ({ name: s.name, tokens: s.tokens })),
    },
    five: u.rateLimits.find((r: any) => r.kind === 'five_hour')?.percentUsed,
    week: u.rateLimits.find((r: any) => r.kind === 'seven_day')?.percentUsed,
    usd: u.cost?.usd,
  }
  return { snap: next, startedAt: u.startedAt as number }
}

const refresh = async ($: any, addPoint: boolean) => {
  try {
    const r = await readUsage($)
    await update($, snap, () => r.snap)
    if (addPoint && r.snap.percent !== undefined) {
      const p = r.snap.percent
      await update($, hist, list => [...list, p].slice(-60))
    }
    return r
  } catch {
    return undefined // 읽기에 실패하면 화면은 마지막 값을 유지
  }
}

// ---------- CSV 기록 ----------
const HEADER = [
  '날짜시간', '세션ID', '구분', '모델', '입력토큰', '출력토큰', '캐시읽기', '캐시쓰기',
  '컨텍스트%', '컨텍스트토큰', '5시간한도%', '7일한도%', '작업폴더', '도구(이름:횟수)',
  'MCP(이름:횟수)', '스킬', '턴번호', '세션길이(분)', '턴시간(초)', '압축', '누적비용USD(참고)',
]
const cell = (v: unknown) => {
  const s = v === undefined || v === null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const pad = (n: number) => String(n).padStart(2, '0')
const stamp = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

const appendRow = async ($: any, row: unknown[]) => {
  if (!(await $.fs.exists(ROOT))) return
  const d = new Date()
  const file = `${LOG_DIR}/${d.getFullYear()}-${pad(d.getMonth() + 1)}.csv`
  const line = row.map(cell).join(',') + '\r\n'
  const old = (await $.fs.exists(file)) ? await $.fs.read(file) : ''
  // 새 파일이면 BOM(엑셀 한글 깨짐 방지)과 머리줄을 먼저 쓴다
  const head = old === '' ? '\uFEFF' + HEADER.map(cell).join(',') + '\r\n' : ''
  await $.fs.write(file, old + head + line)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'session-panel',
      description: '세션 패널 열기: 컨텍스트·토큰·MCP·스킬',
    })
    void $.ui.open({ id: PANE, title: '세션' })
    await refresh($, false)

    return next(e)
  })

  on('command.run', { command: 'session-panel' }, async $ => {
    await $.ui.open({ id: PANE, title: '세션' })
    await refresh($, false)

    return { text: '세션 패널을 열었어요.' }
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool.startsWith('mcp__')) bump(mcps, e.tool)
    else bump(tools, e.tool)

    return next(e)
  })

  on('skill.prompt', async ($, e, next) => {
    bump(skillsUsed, e.skill)

    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    if (done.messages) compacted = true

    return done
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const isMain = e.agentId === undefined
    const r = isMain ? await refresh($, true) : undefined

    // 기록은 실패해도 대화에 영향을 주지 않는다
    const row = async () => {
      try {
        const u = e.usage
        const s = r?.snap
        const [sid, cwd, turns] = await Promise.all([$.session.id(), $.session.cwd(), $.session.turns()])
        await appendRow($, [
          stamp(new Date()), sid, isMain ? '메인' : '서브에이전트', u?.model ?? s?.model ?? '',
          u?.input_tokens, u?.output_tokens, u?.cache_read_input_tokens, u?.cache_creation_input_tokens,
          s?.percent, s?.tokens, s?.five, s?.week, cwd,
          isMain ? joinCounts(tools) : '', isMain ? joinCounts(mcps) : '', isMain ? joinCounts(skillsUsed) : '',
          turns, r ? Math.round((Date.now() - r.startedAt) / 60000) : '',
          Math.round(e.durationMs / 1000), isMain && compacted ? 'Y' : '', s?.usd?.toFixed(4),
        ])
      } catch {
        // 기록 실패는 조용히 넘어간다
      }
    }
    if (isMain) {
      const snapshot = row
      queue = queue.then(snapshot)
      await queue
      tools = new Map()
      mcps = new Map()
      skillsUsed = new Map()
      compacted = false
    } else {
      queue = queue.then(row)
    }

    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const s = await read($, snap)
    const points = await read($, hist)
    const width = Math.max(10, ((e.props as { bodyColumns?: number }).bodyColumns ?? 40) - 8)
    if (!s) return <Text dimColor>첫 숫자를 기다리는 중…</Text>

    const used = s.cats.filter(c => c.kind === 'used').sort((a, z) => z.tokens - a.tokens)
    const pct = s.percent ?? 0

    return (
      <Box flexDirection="column">
        <Text bold>컨텍스트{s.model ? ` · ${s.model}` : ''}</Text>
        <Text color={tone(pct)}>
          {bar(pct, width)} {Math.round(pct)}%
        </Text>
        <Text dimColor>
          {s.tokens !== undefined ? fmt(s.tokens) : '?'} / {fmt(s.window)} 토큰
        </Text>

        {points.length > 1 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>이번 세션 흐름 (턴마다 컨텍스트 %)</Text>
            <Text color="claude">{spark(points, width + 4)}</Text>
          </Box>
        )}

        {(s.five !== undefined || s.week !== undefined) && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>요금제 한도</Text>
            {s.five !== undefined && (
              <Text color={tone(s.five)}>
                5시간 {bar(s.five, width - 4)} {s.five}%
              </Text>
            )}
            {s.week !== undefined && (
              <Text color={tone(s.week)}>
                7일 {'  '}
                {bar(s.week, width - 4)} {s.week}%
              </Text>
            )}
          </Box>
        )}

        <Box flexDirection="column" marginTop={1}>
          <Text bold>항목별 토큰</Text>
          {used.map(c => (
            <Text>
              {c.name}: {fmt(c.tokens)}
            </Text>
          ))}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text bold>MCP ({s.mcp.length})</Text>
          {s.mcp.length === 0 && <Text dimColor>없음</Text>}
          {s.mcp.slice(0, 10).map(m => (
            <Text>
              {m.server}: {fmt(m.tokens)} · 도구 {m.loaded}/{m.tools}
            </Text>
          ))}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text bold>
            스킬{s.skills ? ` (${s.skills.included}/${s.skills.total}개, ${fmt(s.skills.tokens)})` : ''}
          </Text>
          {(s.skills?.top ?? []).map(k => (
            <Text>
              {k.name}: {fmt(k.tokens)}
            </Text>
          ))}
        </Box>

        {s.usd !== undefined && (
          <Box marginTop={1}>
            <Text dimColor>누적 비용 환산 ${s.usd.toFixed(2)} (Pro 요금제에서는 참고용)</Text>
          </Box>
        )}
      </Box>
    )
  })
}
