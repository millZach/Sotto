export function distribution(values) {
  const sorted = values.filter(value => typeof value === 'number' && Number.isFinite(value) && value >= 0).sort((a, b) => a - b)
  const pick = fraction => sorted.length ? sorted[Math.ceil(sorted.length * fraction) - 1] : null
  return { n: sorted.length, p50: pick(.5), p95: pick(.95), max: sorted.at(-1) ?? null }
}

function row(metric, phase, values, target, source) {
  const stats = distribution(values)
  const status = !stats.n ? 'UNMEASURED' : !target ? 'MEASURED' :
    (target.p50 === undefined || stats.p50 <= target.p50) && (target.p95 === undefined || stats.p95 <= target.p95) && (target.max === undefined || stats.max <= target.max) ? 'PASS' : 'FAIL'
  return { metric, phase, ...stats, target, status, source }
}

export function summarizeVoice({ retrieval, capture, playback, turns = [] } = {}) {
  const rows = []
  for (const phase of ['cold', 'warm']) {
    const samples = (capture?.rows ?? []).filter(sample => sample.phase === phase)
    rows.push(row('Acoustic end to shipping UI feedback', phase, [], { p50: 1200, p95: 2000 }, 'Requires a physical input/output + shipping UI trial'))
    rows.push(row('Detector frame to main useful state', phase, samples.map(s => s.timings.speechToFirstFeedbackMs), phase === 'warm' ? { p50: 1200, p95: 2000 } : null, 'Fresh production capture/MAI/coordinator turn records; software reference'))
    rows.push(row('Detector frame to benchmark DOM feedback', phase, samples.map(s => s.speechToRenderedFeedbackMs), phase === 'warm' ? { p50: 1200, p95: 2000 } : null, 'Diagnostic only: hidden benchmark DOM, not shipping UI; frame throttling may apply'))
    rows.push(row('Memory retrieval', phase, phase === 'cold' ? retrieval?.coldConnection?.samplesMs ?? [] : retrieval?.samplesMs ?? [], { p95: 100 }, phase === 'cold' ? 'Fresh first-query/new SQLite connection, OS cache not flushed' : 'Fresh 10,000-row synthetic store after 100 warmups'))
    rows.push(row('Physical hotkey/button to silence', phase, [], { max: 150 }, 'No physical input-device timestamp; programmatic playback stop is separate'))
    for (const [provider, label] of [['grok', 'Grok'], ['kokoro', 'Kokoro']]) {
      // Prior screen reused processes; it does not establish hosted cold-start latency.
      const trials = (playback?.trials ?? []).filter(t => t.provider === provider && t.phase === (phase === 'warm' ? 'screen' : 'cold'))
      const valid = trials.filter(t => t.ok && t.timestampErrors === 0 && t.discontinuities === 0 && t.clockUncertaintyMs < 2)
      rows.push(row(`${label} request to first loopback audio`, phase, valid.map(t => t.onsetMs), phase === 'warm' ? { p95: 300 } : null, 'Historical production playback/WASAPI; 300 ms is former on-device reference, not a new hosted release gate'))
      rows.push(row(`${label} playback interrupt to loopback silence`, phase, valid.filter(t => t.stopValid).map(t => t.stopMs), { max: 100 }, 'Historical production player stop; active-source/observed-silence validation'))
    }
    const observed = turns.filter(t => t.source === 'utterance' && t.timings?.voicePhase === phase)
    if (turns.length) {
      rows.push(row('Imported turn detector-to-main feedback', phase, observed.map(t => t.timings.speechToFirstFeedbackMs), phase === 'warm' ? { p50: 1200, p95: 2000 } : null, 'Explicitly supplied turns.jsonl; never auto-opens personal history'))
      rows.push(row('Imported turn retrieval', phase, observed.filter(t => t.timings.retrievalCount > 0).map(t => t.timings.retrievalMs), { p95: 100 }, 'Only turns that actually invoked retrieval; no missing-stage zeroes'))
      rows.push(row('Imported turn speech-to-intent', phase, observed.map(t => t.timings.speechToIntentMs), null, 'Only stamped reasoner milestones'))
    }
  }
  return { rows }
}

export function markdown(report, provenance) {
  const ms = value => value === null ? 'unmeasured' : value.toFixed(2)
  const target = value => !value ? 'timed separately' : Object.entries(value).map(([key, number]) => `${key} <= ${number}`).join('; ')
  return `# Windows voice budget measurement\n\nGenerated ${provenance.generatedAt}. Durations are milliseconds; percentiles use nearest rank. PASS/FAIL applies only to the stated measurement boundary and workload.\n\n` +
    `| Metric | Phase | n | p50 | p95 | Max | Target ms | Result |\n| --- | --- | ---: | ---: | ---: | ---: | --- | --- |\n` +
    report.rows.map(r => `| ${r.metric} | ${r.phase} | ${r.n} | ${ms(r.p50)} | ${ms(r.p95)} | ${ms(r.max)} | ${target(r.target)} | ${r.status} |`).join('\n') +
    `\n\nRe-run from the repository root with \`npm run perf:voice\`. See \`scripts/voice-perf/README.md\` for prerequisites, isolation, cost bound and report-only replay.\n\n## Boundaries and provenance\n\n` + Object.entries(provenance).map(([key, value]) => `- ${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`).join('\n') +
    `\n\n${[...new Set(report.rows.map(r => r.source))].map(s => '- ' + s).join('\n')}\n\nThe fresh voice workload uses the checked-in synthetic tiny WAV played in real time into a WebAudio MediaStream, production microphone worklet/segmentation/resampling, MAI through OpenRouter, production draft composition and turn recording. Wake detection and provider are fixtures. No reasoning or delegation is invoked, so those stages remain unmeasured. Cold means the first request in each of three new Electron processes (n=3); warm is four later requests in each (n=12). This is a small screen, not a stable population p95. Capture is reopened per trial; remote model residency, disk caches and external load are uncontrolled.\n\nDetector frame receipt excludes unknown hardware/input buffering. Main-state publication precedes renderer IPC and paint. The hidden benchmark DOM timing includes animation-frame scheduling and is diagnostic, not a shipping UI result. No stage sum or historical ASR inference time is substituted for acoustic end-to-end latency. Physical hotkey/button, loaded workload and hosted cold speech playback still require dedicated trials. Historical Grok/Kokoro playback uses the shipping native player and process-tree Windows loopback, not physical speaker acoustics. Provider choices follow MAI transcription, Grok default and Kokoro economical option; the obsolete on-device selection rule does not reverse that choice.\n`
}

