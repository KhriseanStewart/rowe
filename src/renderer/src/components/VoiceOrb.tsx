import voiceOrbMp4 from '../assets/voice-interaction.mp4'
import voiceOrbWebm from '../assets/voice-interaction.webm'

type VoiceOrbProps = {
  className?: string
  label?: string
}

export default function VoiceOrb({
  className = 'h-28 w-full',
  label = 'Rowe listening'
}: VoiceOrbProps): React.JSX.Element {
  return (
    <div className={`voice-orb ${className}`} aria-label={label}>
      <video className="voice-orb-video" autoPlay muted loop playsInline preload="auto">
        <source src={voiceOrbWebm} type="video/webm" />
        <source src={voiceOrbMp4} type="video/mp4" />
      </video>
    </div>
  )
}
