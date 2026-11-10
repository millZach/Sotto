// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  MODELS_DRAWN, PROVIDER_SLOT, QUIET_ROOM, QUIET_RUN, SERIES_SLOTS, assignSlots, axisMarks, chartScale, chartStretches, foldLead, foldRun, keptDays, chooseSeries, measureFigure, remainder, seriesValues, splitPlan, sumFigures, totalPlan, wholeFigure,
  type ChartFigure, type SeriesCandidate,
} from '../../../src/renderer/src/features/usage/usageChartSeries'
import { activityRow, field, tokens } from '../../fixtures/renderer/usageReads'

const model = (key: string, total: number, providerId: SeriesCandidate['providerId'] = 'claude'): SeriesCandidate => ({ key, name: key.toUpperCase(), providerId, total })
/** Whole figures, as prompts always are. */
const whole = (values: readonly number[]): ChartFigure[] => values.map(wholeFigure)
const wholeMap = (entries: ReadonlyArray<readonly [string, readonly number[]]>): Map<string, ChartFigure[]> => new Map(entries.map(([key, values]) => [key, whole(values)]))
const models = [model('a', 50), model('b', 40), model('c', 30, 'codex'), model('d', 20, 'codex'), model('e', 10, 'grok'), model('f', 5), model('g', 2), model('idle', 0)]

describe('Usage chart series', () => {
  it('draws the top five models by the stage measure and puts the rest in Other, offering nothing without activity', () => {
    const choice = chooseSeries('model', [...models].reverse())
    expect(choice.drawn.map(item => item.key)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(choice.drawn).toHaveLength(MODELS_DRAWN)
    expect(choice.rest.map(item => item.key)).toEqual(['f', 'g'])
    expect(chooseSeries('model', models.slice(0, 3)).rest).toEqual([])
    expect(chooseSeries('total', models)).toEqual({ show: 'total', drawn: [], rest: [] })
  })

  it('draws every provider with activity and holds nothing back for Other', () => {
    const providers = [model('claude', 150, 'claude'), model('codex', 50, 'codex'), model('devin', 0, 'devin')]
    const choice = chooseSeries('provider', providers)
    expect(choice.drawn.map(item => item.key)).toEqual(['claude', 'codex'])
    expect(choice.rest).toEqual([])
    const chart = splitPlan({ kind: 'bars', choice, totals: whole([100, 100]), values: wholeMap([['claude', [80, 70]], ['codex', [20, 30]]]), slots: new Map() })
    expect(chart.series.map(item => [item.name, item.tone])).toEqual([['CLAUDE', `${PROVIDER_SLOT.claude}`], ['CODEX', `${PROVIDER_SLOT.codex}`]])
  })

  it('works out Other as the total less the drawn series each day, never below zero, and leaves it out with no rest', () => {
    const choice = chooseSeries('model', models)
    const values = wholeMap([['a', [10, 0, 5]], ['b', [5, 0, 5]], ['c', [0, 1, 0]], ['d', [0, 0, 0]], ['e', [1, 0, 0]]])
    const chart = splitPlan({ kind: 'bars', choice, totals: whole([20, 0, 8]), values, slots: assignSlots(choice.drawn.map(item => item.key), new Map()) })
    const other = chart.series.at(-1)!
    expect(other).toMatchObject({ key: 'other', name: 'Other (2)', tone: 'other', values: [4, 0, 0], total: 4, title: 'F, G' })
    // Bars stack: the tallest day is its whole stack, the day's true total.
    expect(chart).toMatchObject({ stacked: true, peak: 20, ready: true })
    const lines = splitPlan({ kind: 'lines', choice, totals: whole([20, 0, 8]), values, slots: new Map() })
    expect(lines).toMatchObject({ stacked: false, peak: 10 })
    const few = chooseSeries('model', models.slice(0, 2))
    expect(splitPlan({ kind: 'bars', choice: few, totals: whole([30]), values: wholeMap([['a', [10]], ['b', [5]]]), slots: new Map() }).series.map(item => item.key)).toEqual(['a', 'b'])
  })

  it('keeps Other when the ranking left models out, without claiming how many', () => {
    const choice = chooseSeries('model', models.slice(0, 2))
    const chart = splitPlan({ kind: 'bars', choice, totals: whole([30]), values: wholeMap([['a', [10]], ['b', [5]]]), slots: new Map(), incomplete: true })
    expect(chart.series.at(-1)).toMatchObject({ name: 'Other', values: [15] })
  })

  it('names the series but draws nothing until their days arrive', () => {
    const choice = chooseSeries('model', models)
    const chart = splitPlan({ kind: 'bars', choice, totals: whole([20, 5]), values: undefined, slots: new Map() })
    expect(chart.ready).toBe(false)
    expect(chart.series.map(item => item.name)).toEqual(['A', 'B', 'C', 'D', 'E', 'Other (2)'])
    expect(chart.peak).toBe(0)
    expect(chart.series.every(item => item.values.every(value => value === 0))).toBe(true)
  })

  it('keeps a drawn model on its colour when the drawn set changes, and gives a newcomer the lowest free one', () => {
    const first = assignSlots(['a', 'b', 'c', 'd', 'e'], new Map())
    expect([...first.values()]).toEqual([1, 2, 3, 4, 5])
    const next = assignSlots(['c', 'a', 'x', 'e', 'y'], first)
    expect(Object.fromEntries(next)).toEqual({ a: 1, c: 3, e: 5, x: 2, y: 4 })
    // A slot the theme does not have is never kept.
    expect(assignSlots(['a'], new Map([['a', SERIES_SLOTS + 1]])).get('a')).toBe(1)
  })

  it('draws the total as before: prompts in the accent, tokens as input under output or one line of both', () => {
    const days = [{ prompts: 3, input: 100, output: 10 }, { prompts: 0, input: 0, output: 0 }]
    expect(totalPlan('prompts', 'bars', days).series.map(item => [item.tone, item.values])).toEqual([['strong', [3, 0]]])
    expect(totalPlan('tokens', 'bars', days)).toMatchObject({ stacked: true, peak: 110, series: [{ tone: 'input', values: [100, 0] }, { tone: 'output', values: [10, 0] }] })
    expect(totalPlan('tokens', 'lines', days)).toMatchObject({ stacked: false, peak: 110, series: [{ name: 'Input and output', values: [110, 0] }] })
  })

  it('keeps a day whose tokens are partly or not reported as a lower bound or unknown, so its figure says so', () => {
    const days = [{ prompts: 1, input: 100, output: 10, tokensKnown: true, tokensPartial: true }, { prompts: 1, input: 0, output: 0, tokensKnown: false, tokensPartial: false }]
    const plan = totalPlan('tokens', 'bars', days)
    expect(sumFigures(plan.series.map(item => item.figures[0]!))).toEqual({ value: 110, known: true, partial: true })
    expect(sumFigures(plan.series.map(item => item.figures[1]!))).toMatchObject({ known: false })
    expect(totalPlan('prompts', 'bars', days).series[0]!.figures[0]).toEqual(wholeFigure(1))
  })

  it('lists every series with its range total, or with one day value', () => {
    const choice = chooseSeries('model', models.slice(0, 2))
    const chart = splitPlan({ kind: 'lines', choice, totals: whole([15, 9]), values: wholeMap([['a', [10, 4]], ['b', [5, 5]]]), slots: new Map() })
    expect(seriesValues(chart, null).map(row => [row.name, row.figure.value])).toEqual([['A', 14], ['B', 10]])
    expect(seriesValues(chart, 1).map(row => [row.name, row.figure.value])).toEqual([['A', 4], ['B', 5]])
  })

  it('keeps a token figure no record reports as unknown, and one some records leave out as partial, by day and for the range', () => {
    const reported = activityRow(2, 0, 0, tokens(900, 100))
    const unreported = activityRow(1, 0, 0, { ...tokens(), input: field(), output: field(), total: field() }, { tokenRecords: 1 })
    const some = activityRow(1, 0, 0, { ...tokens(), input: field(300, true), output: field(30, true), total: { value: 330, knownRows: 1, rows: 2, partial: true } }, { tokenRecords: 2 })
    expect(measureFigure('tokens', reported)).toMatchObject({ value: 1000, known: true, partial: false })
    expect(measureFigure('tokens', unreported)).toMatchObject({ value: 0, known: false })
    expect(measureFigure('tokens', some)).toMatchObject({ value: 330, known: true, partial: true })
    // A day with no work is a reported zero; prompts are always whole.
    expect(measureFigure('tokens', undefined)).toMatchObject(wholeFigure(0))
    expect(measureFigure('prompts', unreported)).toEqual(wholeFigure(1))
    const [a, b, c, none] = [measureFigure('tokens', reported), measureFigure('tokens', unreported), measureFigure('tokens', some), measureFigure('tokens', undefined)]
    expect(sumFigures([a!, none!])).toMatchObject({ value: 1000, known: true, partial: false })
    expect(sumFigures([a!, b!])).toMatchObject({ value: 1000, known: true, partial: true })
    expect(sumFigures([b!, none!, none!])).toMatchObject({ known: false })
    expect(sumFigures([c!, none!])).toMatchObject({ value: 330, known: true, partial: true })

    const choice = chooseSeries('model', models.slice(0, 1))
    const chart = splitPlan({ kind: 'bars', choice, totals: [a!, sumFigures([a!, b!]), none!], values: new Map([['a', [a!, b!, none!]]]), slots: new Map(), incomplete: true })
    const drawn = seriesValues(chart, null)[0]!
    expect(drawn.figure).toMatchObject({ value: 1000, known: true, partial: true })
    expect(seriesValues(chart, 1)[0]!.figure).toMatchObject({ known: false })
  })

  it('works out whether Other is whole from its own records, not from the total', () => {
    const reported = activityRow(2, 0, 0, tokens(900, 100))
    const unreported = activityRow(1, 0, 0, { ...tokens(), input: field(), output: field(), total: field() }, { tokenRecords: 1 })
    const drawnGap = measureFigure('tokens', unreported)
    // The day's total left one record out, and it was the drawn model's: what is left over is whole.
    const day = sumFigures([measureFigure('tokens', reported), drawnGap])
    expect(day).toMatchObject({ value: 1000, partial: true })
    expect(remainder(day, [drawnGap])).toMatchObject({ value: 1000, known: true, partial: false })
    // The gap was in Other's own records: Other is at least what was reported.
    expect(remainder(day, [measureFigure('tokens', reported)])).toMatchObject({ value: 0, known: false })
    expect(remainder(sumFigures([day, measureFigure('tokens', reported)]), [measureFigure('tokens', reported)])).toMatchObject({ value: 1000, known: true, partial: true })
    // Prompts carry no records, and Other is as whole as the total.
    expect(remainder(wholeFigure(10), [wholeFigure(4)])).toEqual({ value: 6, known: true, partial: false })
  })

  it('folds a long run of empty days in a sparse range into the room of two, keeping every day in order', () => {
    const busy = Array.from({ length: 30 }, (_, at) => [25, 26, 28, 29].includes(at))
    const { stretches, room, start, width } = chartStretches(busy, QUIET_RUN)
    expect(stretches[0]).toEqual({ kind: 'quiet', from: 0, to: 24 })
    // A gap of one day between busy days stays a day of its own.
    expect(stretches.slice(1)).toEqual([25, 26, 27, 28, 29].map(at => ({ kind: 'day', at })))
    expect(room).toBe(QUIET_ROOM + 5)
    expect(start).toHaveLength(30)
    expect(start[25]).toBeCloseTo(QUIET_ROOM / room)
    expect(width[25]).toBeCloseTo(1 / room)
    expect(start[29]! + width[29]!).toBeCloseTo(1)
    // Not asked to fold, or with no run long enough, each day keeps an equal share.
    expect(chartStretches(busy, 0).room).toBe(30)
    expect(chartStretches([true, false, false, false, false, true], QUIET_RUN).room).toBe(6)
  })

  it('folds only days reported as complete zeroes, never days whose tokens nothing reported', () => {
    // Thirty days: work on the last two, the ten before them reported as nothing, and the eighteen before those unreported.
    const days = Array.from({ length: 30 }, (_, at) => at >= 28 ? { prompts: 1, input: 100, output: 10, tokensKnown: true, tokensPartial: false }
      : at >= 18 ? { prompts: 0, input: 0, output: 0, tokensKnown: true, tokensPartial: false }
      : { prompts: 0, input: 0, output: 0, tokensKnown: false, tokensPartial: false })
    const kept = keptDays(totalPlan('tokens', 'bars', days).series, 30)
    expect(kept.slice(0, 18).every(Boolean)).toBe(true)
    expect(kept.slice(18, 28).some(Boolean)).toBe(false)
    expect(chartStretches(kept, QUIET_RUN).stretches.filter(stretch => stretch.kind === 'quiet')).toEqual([{ kind: 'quiet', from: 18, to: 27 }])
    // Prompts are always counted whole, so their empty days fold.
    expect(keptDays(totalPlan('prompts', 'bars', days).series, 30).filter(Boolean)).toHaveLength(2)
  })

  it('folds only a sparse range longer than a week, and draws a busier one day by day', () => {
    expect(foldRun(7, true)).toBe(0)
    expect(foldRun(30, true)).toBe(QUIET_RUN)
    expect(foldRun(30, false)).toBe(0)
    expect(foldRun(90, false)).toBe(0)
    // Thirty days with the work in the last fifteen and more than a few busy days: every day keeps its share.
    const busy = Array.from({ length: 30 }, (_, at) => at >= 15 && ![18, 22, 23].includes(at))
    expect(chartStretches(busy, foldRun(30, false)).room).toBe(30)
  })

  it('folds the empty days before the first prompt into one quiet stretch, however busy the rest is', () => {
    expect(foldLead(7)).toBe(0)
    expect(foldLead(30)).toBe(QUIET_RUN)
    // Sixteen empty days, then twelve busy days with two empty ones among them: only the start folds.
    const busy = Array.from({ length: 30 }, (_, at) => at >= 16 && ![19, 24].includes(at))
    const layout = chartStretches(busy, foldRun(30, false), foldLead(30))
    expect(layout.stretches.filter(stretch => stretch.kind === 'quiet')).toEqual([{ kind: 'quiet', from: 0, to: 15 }])
    expect(layout.room).toBe(14 + QUIET_ROOM)
    expect(axisMarks(30, layout)).toContain(16)
    // An empty start shorter than five days stays day by day, and so does a range with no work at all.
    expect(chartStretches(Array.from({ length: 30 }, (_, at) => at >= 4), 0, foldLead(30)).room).toBe(30)
    expect(chartStretches(Array.from({ length: 30 }, () => false), 0, foldLead(30)).room).toBe(30)
  })

  it('scales the chart to a round top with two or three gridlines at a round step', () => {
    expect(chartScale(28, 10, true)).toEqual({ top: 30, ticks: [10, 20, 30] })
    expect(chartScale(26 * 1.15, 10, true)).toEqual({ top: 30, ticks: [10, 20, 30] })
    // A quiet range keeps its floor, and prompts step in whole numbers.
    expect(chartScale(2, 10, true)).toEqual({ top: 10, ticks: [5, 10] })
    expect(chartScale(4, 1, true)).toEqual({ top: 4, ticks: [2, 4] })
    expect(chartScale(1_200_000, 1e5, false)).toEqual({ top: 1_500_000, ticks: [500_000, 1_000_000, 1_500_000] })
    expect(chartScale(0, 1e5, false)).toEqual({ top: 100_000, ticks: [50_000, 100_000] })
  })

  it('names where the range starts and ends, where a fold ends and each week back from the end, never two dates crowded together', () => {
    expect(axisMarks(7, null)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(axisMarks(30, null)).toEqual([0, 8, 15, 22, 29])
    const busy = Array.from({ length: 30 }, (_, at) => at >= 15)
    // Folded: the start, the first day of work, a week before the end and the end; the week inside the fold is not named.
    expect(axisMarks(30, chartStretches(busy, QUIET_RUN))).toEqual([0, 15, 22, 29])
    // A long range steps by several weeks.
    expect(axisMarks(90, null)).toEqual([0, 26, 47, 68, 89])
  })
})
