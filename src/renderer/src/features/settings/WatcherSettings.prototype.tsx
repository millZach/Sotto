// PROTOTYPE — throwaway. Three places for "Settle finished threads" in Settings, under Watcher, beside today's
// section, switchable from the floating bar or with ← and →. The toggle lives in local state only: no setting exists yet.
import React, { useId, useState, type ReactNode } from 'react'
import { CheckCheck, Eye, Users } from 'lucide-react'
import { Toggle } from '../../components/Toggle'
import { PrototypeSwitcher, prototypesEnabled, usePrototypeVariant } from '../../components/PrototypeSwitcher'
import { SettingsGroup } from './SettingsGroup'
import './watcherSettlePrototype.css'

export const watcherSettlePrototypeEnabled = prototypesEnabled

const VARIANTS = [
  { key: 'A', name: 'Groups, settling first' },
  { key: 'B', name: 'Roles first, settling below' },
  { key: 'C', name: 'Settling first, with what finished means' },
  { key: 'Now', name: 'Today’s section' },
] as const

const LABEL = 'Settle finished threads'
const DESCRIPTION = 'Watcher settles a thread it watches once its work is done: nothing running or waiting on you, and every pull request merged or closed. Then it stops watching it.'
const SUBTITLE = 'How Watcher looks after threads, and what each kind of work runs on'
const FINISHED = [
  'No turn running',
  'No background work or monitoring',
  'No question or permission waiting on you',
  'Nothing queued',
  'Every pull request merged or closed',
] as const

/** The section's heading, as every Settings section draws it. */
function Heading({ subtitle }: { readonly subtitle: string }): ReactNode {
  return <div className="settings-section__heading"><h2>Watcher</h2><p>{subtitle}</p></div>
}

export function WatcherSettlePrototype({ roles, current }: { readonly roles: ReactNode; readonly current: ReactNode }): ReactNode {
  const [variant, choose] = usePrototypeVariant(VARIANTS, 'watcher-settle-toggle')
  const [settle, setSettle] = useState(true)
  const toggle = <Toggle label={LABEL} checked={settle} onCheckedChange={setSettle} description={DESCRIPTION} />
  return <>
    {variant === 'A' ? <VariantA toggle={toggle} roles={roles} /> : null}
    {variant === 'B' ? <VariantB toggle={toggle} roles={roles} /> : null}
    {variant === 'C' ? <VariantC toggle={toggle} roles={roles} settle={settle} /> : null}
    {variant === 'Now' ? current : null}
    <PrototypeSwitcher variants={VARIANTS} current={variant} onChoose={choose} />
  </>
}

// ---- A: two small groups, as Git groups its rows. Watched threads first, worker roles under their own heading. ----

function VariantA({ toggle, roles }: { readonly toggle: ReactNode; readonly roles: ReactNode }): ReactNode {
  const rolesId = useId()
  return <div className="watcher-proto watcher-proto--a">
    <Heading subtitle={SUBTITLE} />
    <SettingsGroup title="Watched threads" icon={Eye}>{toggle}</SettingsGroup>
    {/* Worker roles keeps its own Reset all; its heading becomes a group heading like the one above. */}
    <section className="settings-group watcher-proto__roles" aria-labelledby={rolesId}>
      <h3 id={rolesId}><Users size={16} strokeWidth={1.7} aria-hidden="true" />Worker roles</h3>
      <div className="watcher-proto__roles-body">{roles}</div>
    </section>
  </div>
}

// ---- B: worker roles first as today, then the toggle as its own group, separated as Settings groups are. ----

function VariantB({ toggle, roles }: { readonly toggle: ReactNode; readonly roles: ReactNode }): ReactNode {
  return <div className="watcher-proto watcher-proto--b">
    <Heading subtitle="What each kind of work runs on, and how Watcher looks after threads" />
    {roles}
    <SettingsGroup title="When work is done" icon={CheckCheck}>{toggle}</SettingsGroup>
  </div>
}

// ---- C: the toggle leads, and while it is on, a plain list under its description says what finished means. ----

function VariantC({ toggle, roles, settle }: { readonly toggle: ReactNode; readonly roles: ReactNode; readonly settle: boolean }): ReactNode {
  const listId = useId()
  return <div className="watcher-proto watcher-proto--c">
    <Heading subtitle={SUBTITLE} />
    <div className="settings-rows">
      <div className="watcher-proto__settle">
        {toggle}
        {settle ? <div className="watcher-proto__finished">
          <p id={listId}>Finished means</p>
          <ul aria-labelledby={listId}>{FINISHED.map(item => <li key={item}>{item}</li>)}</ul>
        </div> : null}
      </div>
    </div>
    <div className="watcher-proto__roles-c">{roles}</div>
  </div>
}
