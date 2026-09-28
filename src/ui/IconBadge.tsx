import Icon, { type IconName } from './Icon'

type IconBadgeProps = {
  icon: IconName
  /** Disc diameter in px; the glyph scales with it. */
  size?: number
}

/** The design system's glowing blue disc. Decorative. */
export default function IconBadge({ icon, size = 72 }: IconBadgeProps) {
  return (
    <div
      className="icon-badge"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <div className="icon-badge__disc">
        <Icon name={icon} size={Math.round(size * 0.4)} />
      </div>
    </div>
  )
}
