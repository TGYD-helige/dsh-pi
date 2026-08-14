import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'vitest'
import {
  parseReviewOutput,
  prepareDshReview,
  publishDshReview,
  reviewLocationIndex,
  summaryBody,
} from './publish-dsh-review.mjs'

const finding = {
  severity: 'P1',
  axis: 'Standards',
  path: 'src/example.ts',
  line: 11,
  side: 'RIGHT',
  title: 'Unchecked failure path',
  body: 'The added call can throw before cleanup runs.',
  fix: 'Move cleanup into a finally block.',
}

test('parses and renders the Pi-compatible Standards and Spec format', () => {
  assert.deepEqual(parseReviewOutput(`\`\`\`json\n${JSON.stringify({ findings: [finding] })}\n\`\`\``), [finding])
  assert.throws(
    () => parseReviewOutput(JSON.stringify({ findings: [finding, { ...finding, title: 'Duplicate location' }] })),
    /same axis and changed line/,
  )
  const body = summaryBody([finding], { owner: 'owner', repo: 'repo', headSha: 'head', baseSha: 'base' })
  assert.match(body, /^<!-- dsh-code-review -->\n## Standards/)
  assert.match(body, /## Spec\n\nNo actionable findings\./)
  assert.match(body, /Standards: 1 finding, highest P1; Spec: no findings/)
})

test('prepares bounded PR data behind a runtime-generated untrusted boundary', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-review-context-'))
  const contextPath = path.join(directory, 'context.md')
  await writeFile(path.join(directory, 'AGENTS.md'), '# Trusted review rules')
  const listFiles = () => {}
  const listCommits = () => {}
  const github = {
    request: async () => ({ data: 'diff --git a/src/example.ts b/src/example.ts' }),
    paginate: async (method) => {
      if (method === listFiles) return [{ filename: 'src/example.ts', patch: '@@ -10 +10,2 @@\n old\n+new' }]
      if (method === listCommits) return []
      throw new Error('Unexpected pagination method')
    },
    rest: {
      pulls: { listFiles, listCommits },
      issues: { get: async () => { throw new Error('Unexpected issue lookup') } },
    },
  }
  try {
    await prepareDshReview({
      github,
      context: {
        repo: { owner: 'owner', repo: 'repo' },
        payload: {
          pull_request: {
            number: 123,
            title: 'Test review preparation',
            body: '',
            base: { sha: 'base123' },
            head: { sha: 'head123' },
          },
        },
      },
      core: { warning: () => {} },
      contextPath,
      workspace: directory,
    })
    const prompt = await readFile(contextPath, 'utf8')
    const boundaries = [...prompt.matchAll(/DSH_REVIEW_UNTRUSTED_[0-9a-f-]+/g)].map((match) => match[0])
    assert.equal(boundaries.length, 2)
    assert.equal(boundaries[0], boundaries[1])
    assert.match(prompt, /# Trusted base-revision standards\n\n### AGENTS\.md\n# Trusted review rules/)
    assert.match(prompt, /src\/example\.ts\tRIGHT\t11/)
    assert.match(prompt, /Return ONLY one JSON object/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('publishes inline findings and fails the check for P0 or P1', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-review-publish-'))
  const reviewPath = path.join(directory, 'review.json')
  await writeFile(reviewPath, JSON.stringify({ findings: [finding] }))
  const calls = []
  const failures = []
  const listFiles = () => {}
  const github = {
    paginate: async (method) => {
      if (method === listFiles) return [{ filename: 'src/example.ts', patch: '@@ -10 +10,2 @@\n old\n+new' }]
      throw new Error('Unexpected pagination method')
    },
    rest: {
      pulls: {
        listFiles,
        createReview: async (args) => calls.push(args),
      },
    },
  }
  try {
    await publishDshReview({
      github,
      context: {
        repo: { owner: 'owner', repo: 'repo' },
        payload: { pull_request: { number: 123, head: { sha: 'head' }, base: { sha: 'base' } } },
      },
      core: { info: () => {}, warning: () => {}, setFailed: (message) => failures.push(message) },
      reviewPath,
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
  assert.equal(calls.length, 1)
  assert.equal(calls[0].event, 'COMMENT')
  assert.equal(calls[0].comments.length, 1)
  assert.equal(calls[0].comments[0].line, 11)
  assert.deepEqual(failures, ['DSH review found 1 blocking P0/P1 finding(s)'])
})

test('extracts only changed lines and keeps the privileged workflow on the base revision', async () => {
  assert.equal(
    reviewLocationIndex([{ filename: 'src/example.ts', patch: '@@ -10,2 +10,3 @@\n same\n-old\n+new\n+more' }]),
    'src/example.ts\tLEFT\t11\nsrc/example.ts\tRIGHT\t11\nsrc/example.ts\tRIGHT\t12',
  )
  const workflow = await readFile(new URL('../workflows/dsh-review.yml', import.meta.url), 'utf8')
  const modelPatch = await readFile(new URL('../dsh-review/model.patch.yml', import.meta.url), 'utf8')
  assert.match(workflow, /pull_request_target:/)
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/)
  assert.doesNotMatch(workflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/)
  assert.match(workflow, /DSH_INTEGRATION_BASE_URL/)
  assert.doesNotMatch(workflow, /cat \"\$DSH_REVIEW_CONTEXT\"/)
  assert.match(modelPatch, /model: deepseek-v4-flash/)
  assert.match(modelPatch, /readFileSync\(process\.env\.DSH_REVIEW_CONTEXT/)
  for (const tool of ['tool-bash', 'tool-fs', 'tool-skill', 'tool-subagent', 'tool-workflow', 'tool-web']) {
    assert.match(modelPatch, new RegExp(`- id: ${tool}\\n  disabled: true`))
  }
})
