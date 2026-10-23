import React, { memo, type ReactNode } from 'react'
import { plural, t } from '@lingui/core/macro'
import { Plural, Trans, useLingui } from '@lingui/react/macro'

import {
  hourLabel,
  minutesLabel,
  shortDate,
  type CalendarCell,
  type JournalStats as Stats,
} from './journalFacts'

const count = (value: number): string => value.toLocaleString()

/** "1,240 words": the count as the column writes it, in a message that can say it in the reader's plural. */
function wordCount(words: number): string {
  const shown = count(words)
  return plural(words, { one: `${shown} word`, other: `${shown} words` })
}

/**
 * The Journal's stats column: today against your usual pace, speed over the last 30 days, the streak and its
 * 13-week calendar, where the words went, and this month's time saved and busiest hour. Every chart carries a
 * text alternative. Below 900 pixels of room the column becomes a row of the two figure sections and the charts
 * (the sections marked wide) step aside.
 */
export const JournalStats = memo(function JournalStats({ stats, typingWpm }: { readonly stats: Stats; readonly typingWpm: number }): ReactNode {
  const { t } = useLingui()
  const { today, usual, month } = stats
  const todayPace = today.wpm === null
    ? usual === null ? { value: '0', label: t`wpm today` } : { value: String(usual), label: t`wpm, your usual` }
    : { value: String(today.wpm), label: usual === null ? t`wpm today` : t`wpm, usual ${usual}` }
  const dictations = count(today.count)
  const dictationCount = today.count
  const { streak, longestStreak } = stats
  return (
    <aside className="journal-stats" aria-label={t`Your dictation`}>
      <section className="journal-stats__section">
        <StatsHeading><Trans>Today</Trans></StatsHeading>
        <div className="journal-pair">
          <Figure value={count(today.words)} label={today.count === 0 ? t`words so far` : plural(dictationCount, { one: `words in ${dictations} dictation`, other: `words in ${dictations} dictations` })} />
          <Figure value={todayPace.value} label={todayPace.label} />
        </div>
      </section>
      <section className="journal-stats__section" data-wide="">
        <StatsHeading><Trans>Speed, last 30 days</Trans></StatsHeading>
        <SpeedChart speed={stats.speed} usual={usual} />
      </section>
      <section className="journal-stats__section" data-wide="">
        <StatsHeading>{stats.streak > 0 ? <Plural value={streak} one="#-day streak" other="#-day streak" /> : <Trans>Streak</Trans>}</StatsHeading>
        <StreakCalendar weeks={stats.calendar} days={stats.calendarDays} />
        <div className="journal-calendar__foot">
          <span>{stats.longestStreak > 0 ? <Plural value={longestStreak} one="Longest # day" other="Longest # days" /> : <Trans>No streak yet</Trans>}</span>
          <span className="journal-legend" aria-hidden="true">{t({ message: 'Less', comment: 'The streak calendar legend: fewer words' })} <i data-level="0" /><i data-level="1" /><i data-level="2" /><i data-level="3" /><i data-level="4" /> {t({ message: 'More', comment: 'The streak calendar legend: more words' })}</span>
        </div>
      </section>
      <section className="journal-stats__section" data-wide="">
        <StatsHeading><Trans>Where, last 30 days</Trans></StatsHeading>
        {stats.where.length === 0
          ? <p className="journal-stats__quiet tt-paragraph"><Trans>No app noted yet. Sotto notes the app it pastes into.</Trans></p>
          : <ul className="journal-where">
            {stats.where.map(({ app, words, share }) => (
              <li key={app}>
                <span className="journal-where__name">{app}</span>
                <span className="journal-where__value">{Math.round(share * 100)}%<small>{wordCount(words)}</small></span>
                <span className="journal-meter" aria-hidden="true"><i style={{ width: `${Math.max(2, Math.round((share / stats.where[0]!.share) * 100))}%` }} /></span>
              </li>
            ))}
          </ul>}
      </section>
      <section className="journal-stats__section">
        <StatsHeading><Trans>This month</Trans></StatsHeading>
        <div className="journal-pair">
          <Figure value={minutesLabel(month.savedMinutes)} label={t`saved against typing at ${typingWpm} wpm`} />
          {month.busiestHour === null ? null : <Figure value={hourLabel(month.busiestHour)} label={t`your busiest hour`} />}
        </div>
      </section>
    </aside>
  )
})

/** One figure and what it counts, read in that order: "1,240 words in 7 dictations". */
function Figure({ value, label }: { readonly value: string; readonly label: string }): ReactNode {
  return <p className="journal-figure"><b>{value}</b> <span>{label}</span></p>
}

function StatsHeading({ children }: { readonly children: ReactNode }): ReactNode {
  return <h2 className="journal-stats__heading">{children}</h2>
}

const SPEED_WIDTH = 300
const SPEED_HEIGHT = 120
const SPEED_LEFT = 28
const SPEED_BOTTOM = 18
const SPEED_TOP = 6

/** Words a minute for each day of the last 30 with a timed dictation, over a dashed line at your usual. */
export function SpeedChart({ speed, usual }: { readonly speed: Stats['speed']; readonly usual: number | null }): ReactNode {
  const { t } = useLingui()
  const points = speed.map((point, index) => ({ ...point, index })).filter((point): point is { day: number; wpm: number; index: number } => point.wpm !== null)
  if (points.length < 2) return <p className="journal-stats__quiet tt-paragraph"><Trans>Your speed shows here once you have dictated on two days.</Trans></p>
  const values = points.map((point) => point.wpm).concat(usual === null ? [] : [usual])
  const low = Math.max(0, Math.floor((Math.min(...values) - 8) / 10) * 10)
  const high = Math.ceil((Math.max(...values) + 8) / 10) * 10
  const x = (index: number): number => SPEED_LEFT + (index * (SPEED_WIDTH - SPEED_LEFT - 4)) / Math.max(1, speed.length - 1)
  const y = (value: number): number => SPEED_TOP + ((high - value) / Math.max(1, high - low)) * (SPEED_HEIGHT - SPEED_TOP - SPEED_BOTTOM)
  const line = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${x(point.index).toFixed(1)},${y(point.wpm).toFixed(1)}`).join('')
  const first = points[0]!
  const last = points.at(-1)!
  const area = `${line}L${x(last.index).toFixed(1)},${SPEED_HEIGHT - SPEED_BOTTOM}L${x(first.index).toFixed(1)},${SPEED_HEIGHT - SPEED_BOTTOM}Z`
  const fastest = points.reduce((best, point) => (point.wpm > best.wpm ? point : best), first)
  const slowest = points.reduce((best, point) => (point.wpm < best.wpm ? point : best), first)
  const dayCount = points.length
  const slowestWpm = slowest.wpm
  const fastestWpm = fastest.wpm
  const fastestDay = shortDate(fastest.day)
  const summary = usual === null
    ? t`Words per minute on the ${dayCount} of the last 30 days you dictated, from ${slowestWpm} to ${fastestWpm}, fastest on ${fastestDay}.`
    : t`Words per minute on the ${dayCount} of the last 30 days you dictated, from ${slowestWpm} to ${fastestWpm}, fastest on ${fastestDay}, against your usual ${usual}.`
  const middle = Math.round((low + high) / 2)
  const ticks = [0, Math.floor((speed.length - 1) / 2), speed.length - 1]
  return (
    <svg className="journal-chart" viewBox={`0 0 ${SPEED_WIDTH} ${SPEED_HEIGHT}`} role="img" aria-label={summary}>
      <title>{summary}</title>
      {[low, middle, high].map((value) => (
        <g key={value} aria-hidden="true">
          <line className="journal-chart__grid" x1={SPEED_LEFT} x2={SPEED_WIDTH} y1={y(value)} y2={y(value)} />
          <text className="journal-chart__axis" x={0} y={y(value) + 4}>{value}</text>
        </g>
      ))}
      {usual === null ? null : <line className="journal-chart__usual" x1={SPEED_LEFT} x2={SPEED_WIDTH} y1={y(usual)} y2={y(usual)} />}
      <path className="journal-chart__area" d={area} />
      <path className="journal-chart__line" d={line} />
      {points.map((point) => {
        const day = shortDate(point.day)
        const wpm = point.wpm
        return <circle key={point.day} className="journal-chart__dot" cx={x(point.index)} cy={y(point.wpm)} r={2.4}><title>{t`${day}: ${wpm} wpm`}</title></circle>
      })}
      {ticks.map((index, place) => (
        <text key={index} className="journal-chart__axis" x={x(index)} y={SPEED_HEIGHT - 4} textAnchor={place === 0 ? 'start' : place === 2 ? 'end' : 'middle'} aria-hidden="true">{shortDate(speed[index]!.day)}</text>
      ))}
    </svg>
  )
}

const CELL = 14
const CELL_GAP = 4
const CALENDAR_LEFT = 28
const CALENDAR_TOP = 16

function cellName(cell: CalendarCell): string {
  const date = new Date(cell.day).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
  const amount = cell.words === 0 ? t`no dictation` : wordCount(cell.words)
  return cell.today ? t`Today, ${date}: ${amount}` : t`${date}: ${amount}`
}

/** Thirteen weeks of days, a column a week, darker on days with more words, today ringed. Each day names itself. */
export function StreakCalendar({ weeks, days }: { readonly weeks: Stats['calendar']; readonly days: number }): ReactNode {
  const width = CALENDAR_LEFT + weeks.length * (CELL + CELL_GAP)
  const height = CALENDAR_TOP + 7 * (CELL + CELL_GAP)
  const { t } = useLingui()
  const weekCount = weeks.length
  const weekdayNames = [1, 3, 5].map((weekday) => ({ weekday, name: new Date(2026, 0, 4 + weekday).toLocaleDateString(undefined, { weekday: 'short' }) }))
  return (
    <svg className="journal-chart journal-calendar" viewBox={`0 0 ${width} ${height}`} role="group"
      aria-label={t`Days with dictation over the last ${weekCount} weeks: ${days} of them, darker on days with more words`}>
      {weekdayNames.map(({ weekday, name }) => <text key={weekday} className="journal-chart__axis" x={0} y={CALENDAR_TOP + weekday * (CELL + CELL_GAP) + CELL - 3} aria-hidden="true">{name}</text>)}
      {weeks.map((column, week) => {
        // A month is named over the first week that starts in it; the first column only when the month has two
        // weeks left in it, so its name never runs into the next one's.
        const first = column[0]
        const previous = week === 0 ? undefined : weeks[week - 1]![0]
        const date = first === null || first === undefined ? null : new Date(first.day)
        const named = date !== null && (previous === undefined || previous === null
          ? date.getDate() <= 14
          : new Date(previous.day).getMonth() !== date.getMonth())
        const month = named && date !== null
          ? <text className="journal-chart__axis" x={CALENDAR_LEFT + week * (CELL + CELL_GAP)} y={11} aria-hidden="true">{date.toLocaleDateString(undefined, { month: 'short' })}</text>
          : null
        return (
          <g key={week}>
            {month}
            {column.map((cell, weekday) => cell === null ? null : (
              <rect key={cell.day} className="journal-calendar__cell" data-level={cell.level} data-today={cell.today || undefined}
                x={CALENDAR_LEFT + week * (CELL + CELL_GAP)} y={CALENDAR_TOP + weekday * (CELL + CELL_GAP)} width={CELL} height={CELL} rx={2.5}
                role="img" aria-label={cellName(cell)}>
                <title>{cellName(cell)}</title>
              </rect>
            ))}
          </g>
        )
      })}
    </svg>
  )
}
