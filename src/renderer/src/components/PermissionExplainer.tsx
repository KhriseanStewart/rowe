import type { PermissionStatus } from '../lib/toolUi'

type Props = {
  status: PermissionStatus
  onOpenSettings: (kind: 'screenRecording' | 'accessibility') => void
}

function pill(state: PermissionStatus['screenRecording']): string {
  if (state === 'granted') return 'Granted'
  if (state === 'denied') return 'Denied'
  return 'Not checked'
}

export default function PermissionExplainer({ status, onOpenSettings }: Props): React.JSX.Element {
  return (
    <section className="ui-section desktop-settings-block">
      <p className="ui-section-title">macOS permissions</p>
      <p className="ui-copy" style={{ marginTop: 0 }}>
        Rowe asks before Screen Recording or Accessibility control. Open System Settings if a prompt
        was missed.
      </p>
      <div className="perm-grid">
        <div className="perm-card">
          <div className="perm-card-top">
            <span className="font-semibold">Screen Recording</span>
            <span className={`perm-pill is-${status.screenRecording}`}>{pill(status.screenRecording)}</span>
          </div>
          <p className="ui-copy">Needed for window-specific screenshots.</p>
          <button
            type="button"
            className="ui-btn ui-btn-ghost"
            onClick={() => onOpenSettings('screenRecording')}
          >
            Open Screen Recording settings
          </button>
        </div>
        <div className="perm-card">
          <div className="perm-card-top">
            <span className="font-semibold">Accessibility</span>
            <span className={`perm-pill is-${status.accessibility}`}>{pill(status.accessibility)}</span>
          </div>
          <p className="ui-copy">Needed for limited click/type/focus actions.</p>
          <button
            type="button"
            className="ui-btn ui-btn-ghost"
            onClick={() => onOpenSettings('accessibility')}
          >
            Open Accessibility settings
          </button>
        </div>
      </div>
    </section>
  )
}
