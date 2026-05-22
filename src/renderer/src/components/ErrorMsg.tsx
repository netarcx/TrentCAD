import { useState } from 'react'

export default function ErrorMsg({ text, className = 'admin-error', style }: {
  text: string
  className?: string
  style?: React.CSSProperties
}) {
  const [copied, setCopied] = useState(false)

  const copy = () => {
    // Chrome can reject clipboard.writeText with "Document is not
    // focused" if the window loses focus between the click and the
    // API call. Swallow so it doesn't bubble up as an unhandled
    // promise rejection (which used to nuke the whole renderer
    // via main.tsx's pre-mount overlay — see the v3.0.22 fix).
    navigator.clipboard.writeText(text).catch(() => { /* clipboard blocked */ })
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className={className} style={style}>
      <span className="error-msg-text">{text}</span>
      <button className="error-copy-btn" onClick={copy} title="Copy error">
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}
