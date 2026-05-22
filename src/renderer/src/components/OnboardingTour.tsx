import { useState } from 'react'

interface Props {
  onClose: () => void
}

const STEPS = [
  {
    title: 'Welcome to FrameCAD',
    body: 'A quick tour of the buttons you\'ll use every day. Takes about 30 seconds.'
  },
  {
    title: 'Sync',
    body: 'Click "Sync" before you start working to pull the latest team files. Your teammates send changes through Publish — Sync is how you receive their work.'
  },
  {
    title: '+ Part / + Assembly',
    body: 'Reserves a unique part number and creates a new SolidWorks document for you to edit. Saves you typing the filename — FrameCAD generates year-team-subsystem-part numbers automatically based on your team\'s prefix.'
  },
  {
    title: 'Check Out, then Check In',
    body: 'Before editing a file, click "Check Out" to lock it so nobody else can change it at the same time. Save your work in SolidWorks, then click "Check In" to release the lock for your teammates.'
  },
  {
    title: 'Publish',
    body: 'Once you\'re done for the day, click "Publish" to send your changes to the team. Optionally describe what you changed (or leave blank for a random label).'
  },
  {
    title: 'Need help?',
    body: 'Full setup and workflow guide at github.com/netarcx/FrameCAD/blob/main/docs/STUDENT_SETUP.md. Ask your CAD lead if anything looks broken.'
  }
]

export default function OnboardingTour({ onClose }: Props) {
  const [step, setStep] = useState(0)

  const isLast = step === STEPS.length - 1
  const current = STEPS[step]

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal onboarding-modal" onClick={e => e.stopPropagation()}>
        <div className="onboarding-step-count">
          Step {step + 1} of {STEPS.length}
        </div>
        <h2>{current.title}</h2>
        <p className="onboarding-body">{current.body}</p>
        <div className="onboarding-dots">
          {STEPS.map((_, i) => (
            <span key={i} className={`onboarding-dot${i === step ? ' active' : ''}`} />
          ))}
        </div>
        <div className="actions">
          <button className="toolbar-btn" onClick={onClose}>Skip</button>
          {step > 0 && (
            <button className="toolbar-btn" onClick={() => setStep(step - 1)}>Back</button>
          )}
          <button className="toolbar-btn primary" onClick={() => isLast ? onClose() : setStep(step + 1)}>
            {isLast ? 'Get started' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  )
}
