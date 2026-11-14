import { Hammer } from 'lucide-react'
import { Empty } from '../ui/kit'

/** Placeholder while a page is being built. */
export const Stub = ({ name }: { name: string }) => <Empty title={name} icon={<Hammer />}>This screen is being built.</Empty>
