import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../lib/api'
import { money } from '../../lib/format'
import { useLookups } from '../../lib/hooks'
import { Button, ErrorNote, Input, PageHeader, Spinner } from '../../ui/kit'
import { useToast } from '../../ui/toast'
import { ReceiptInput, uploadReceipt } from '../finance/Expenses'
import { Done, Pick, SaveBar, Step } from './parts'

const PAID = [
  { value: 'cash', label: 'Cash' }, { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'card', label: 'Card' }, { value: 'online', label: 'Online / wallet' },
]

/** Expense by tapping: what kind, how much, how it was paid, optional photo of the bill. */
export default function QuickExpense() {
  const { data: lk, isLoading } = useLookups()
  const qc = useQueryClient()
  const toast = useToast()
  const [category, setCategory] = useState<number>()
  const [amount, setAmount] = useState('')
  const [paid, setPaid] = useState('cash')
  const [note, setNote] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [done, setDone] = useState<any>(null)

  const cats = lk?.expense_categories ?? []
  const catName = cats.find((c) => c.id === category)?.name ?? ''
  const ready = !!category && Number(amount) > 0

  const reset = () => { setCategory(undefined); setAmount(''); setPaid('cash'); setNote(''); setFile(null); setError(null); setDone(null) }

  const save = async () => {
    setBusy(true); setError(null)
    try {
      const e = await api.post('/expenses', { category_id: category, amount, payment_method: paid, description: note.trim() || catName })
      if (file) await uploadReceipt(e.id, file).catch(() => toast('Expense saved, but the photo did not upload', 'error'))
      qc.invalidateQueries({ queryKey: ['/expenses'] })
      setDone(e)
      window.scrollTo(0, 0)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  if (done) return (
    <Done title="Expense saved" actions={[
      { label: 'Add another expense', onClick: reset, primary: true },
      { label: 'Back to home', to: '/' },
    ]}>{done.description} · {money(done.amount)}</Done>
  )

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Add an expense" subtitle="Anything you spent money on for the business." />
      <div className="flex flex-col gap-4">
        <Step n={1} title="What was it for?">
          {isLoading ? <Spinner /> : cats.length
            ? <Pick value={category} onChange={setCategory} options={cats.map((c) => ({ value: c.id, label: c.name }))} />
            : <p className="text-[13.5px] text-muted">No expense types yet. The owner can add them in Settings.</p>}
          <Input className="mt-3 h-12 text-[15px]" placeholder="A note, if you like (e.g. sugar from Metro)" value={note} onChange={(e) => setNote(e.target.value)} />
        </Step>

        <Step n={2} title="How much?">
          <div className="relative">
            <span className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-[16px] text-muted">Rs</span>
            <Input type="number" inputMode="decimal" min="0" className="h-14 pl-12 text-[22px] font-semibold" placeholder="0"
              value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount in rupees" />
          </div>
        </Step>

        <Step n={3} title="How did you pay?">
          <Pick value={paid} onChange={setPaid} options={PAID} />
        </Step>

        <Step n={4} title="Photo of the bill (optional)">
          <ReceiptInput file={file} onChange={setFile} />
        </Step>

        {error != null && <ErrorNote error={error} />}
      </div>

      <SaveBar>
        <p className="min-w-0 flex-1 truncate text-[14px] text-ink-2">{ready ? `${catName} · ${money(amount)}` : 'Pick a type and amount'}</p>
        <Button variant="primary" className="h-14 px-8 text-[16px]" loading={busy} disabled={!ready} onClick={save}>Save expense</Button>
      </SaveBar>
    </div>
  )
}
