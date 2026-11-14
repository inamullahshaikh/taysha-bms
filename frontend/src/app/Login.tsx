import logo from '../assets/logo.webp'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { Button, ErrorNote, Field, Input } from '../ui/kit'

export function Login({ expired }: { expired?: boolean }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const loc = useLocation()
  const from = (loc.state as { from?: string } | null)?.from ?? '/'
  const [step, setStep] = useState<'password' | 'code'>('password')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  const done = async () => {
    await qc.invalidateQueries({ queryKey: ['session'] })
    navigate(from, { replace: true })
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      if (step === 'password') {
        const r = await api.post<{ mfa_required: boolean }>('/auth/login', { email, password })
        if (r.mfa_required) setStep('code')
        else await done()
      } else {
        await api.post('/auth/2fa/verify', { code: code.replace(/\s/g, '') })
        await done()
      }
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-dvh lg:grid-cols-[1fr_1.1fr]">
      <div className="relative hidden flex-col justify-between overflow-hidden bg-wine-800 p-12 text-cream lg:flex">
        <img src={logo} alt="Taysha" className="h-10 w-auto self-start" />
        <div className="relative z-10 max-w-md">
          <p className="font-display text-[44px] leading-[1.05]">Every order, batch and rupee in one place.</p>
          <p className="mt-4 text-[15px] leading-relaxed text-cream/70">Sales, stock, production and the books for the Taysha team.</p>
        </div>
        <p className="text-[12px] text-cream/45">Taysha · internal use only</p>
        <div className="absolute -right-28 -bottom-28 size-[420px] rounded-full bg-wine-700" aria-hidden />
      </div>

      <div className="flex flex-col items-center justify-center bg-page px-5 py-10">
        <div className="mb-8 flex h-14 items-center rounded-xl bg-wine-800 px-4 lg:hidden"><img src={logo} alt="Taysha" className="h-8" /></div>
        <form onSubmit={submit} className="w-full max-w-[360px]">
          <h1 className="font-display text-[28px] text-wine-800">{step === 'password' ? 'Sign in' : 'Two-step check'}</h1>
          <p className="mt-1 mb-6 text-[13.5px] text-ink-2">
            {step === 'password'
              ? expired ? 'Your session ended. Sign in again to carry on where you were.' : 'Use the email your manager set up for you.'
              : 'Enter the 6-digit code from your authenticator app, or a recovery code.'}
          </p>
          <div className="flex flex-col gap-4">
            {error != null && <ErrorNote error={error} />}
            {step === 'password' ? (
              <>
                <Field label="Email" htmlFor="email">
                  <Input id="email" type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
                </Field>
                <Field label="Password" htmlFor="password">
                  <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
                </Field>
              </>
            ) : (
              <Field label="Code" htmlFor="code">
                <Input id="code" inputMode="numeric" autoComplete="one-time-code" required autoFocus value={code}
                  className="h-11 text-center text-[18px] tracking-[0.3em]" onChange={(e) => setCode(e.target.value)} />
              </Field>
            )}
            <Button type="submit" variant="primary" loading={busy} className="mt-1 h-10 w-full">
              {step === 'password' ? 'Sign in' : 'Verify'}
            </Button>
            {step === 'code' && (
              <button type="button" className="text-[12.5px] text-ink-2 hover:text-ink" onClick={() => { setStep('password'); setCode(''); setError(null) }}>
                Use a different account
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  )
}
