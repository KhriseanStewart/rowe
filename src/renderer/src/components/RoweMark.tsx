import logo from '../assets/rowe-logo.png'

type RoweMarkProps = {
  className?: string
}

export default function RoweMark({ className = 'size-9' }: RoweMarkProps): React.JSX.Element {
  return (
    <img
      src={logo}
      alt="Rowe"
      className={`rounded-[11px] bg-white object-cover shadow-[0_0_0_1px_rgba(0,0,0,0.08)] ${className}`}
    />
  )
}
