import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Guard, NotFound, SectionLayout, Shell } from './app/Shell'
import { Login } from './app/Login'
import { ApiError } from './lib/api'
import { AuthProvider, useSession } from './lib/auth'
import { SECTIONS } from './modules'
import { ErrorNote, Loading } from './ui/kit'
import { ToastProvider } from './ui/toast'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // reuse anything fetched in the last minute (moving between tabs and back costs no requests);
      // every save invalidates what it changed, so this never hides your own edits
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
    },
  },
})

/** Signed-in area: sends visitors to /login and brings them back afterwards. */
function Authed() {
  const { data, isLoading, error } = useSession()
  const loc = useLocation()
  if (isLoading) return <div className="pt-[30vh]"><Loading /></div>
  if (error) return <div className="mx-auto max-w-md pt-[30vh]"><ErrorNote error={error} /></div>
  if (!data) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />
  return <AuthProvider session={data}><Shell /></AuthProvider>
}

function LoginRoute() {
  const { data, isLoading } = useSession()
  const loc = useLocation()
  if (isLoading) return null
  if (data) return <Navigate to="/" replace />
  return <Login expired={!!(loc.state as any)?.from && (loc.state as any).from !== '/'} />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginRoute />} />
            <Route element={<Authed />}>
              {SECTIONS.map((s) => [
                s.bare ? (
                  s.pages.map((p) => <Route key={p.path} path={p.path} element={<Guard access={p.access}>{p.element}</Guard>} />)
                ) : (
                  <Route key={s.key} element={<SectionLayout section={s} />}>
                    {s.pages.map((p) => <Route key={p.path} path={p.path} element={<Guard access={p.access}>{p.element}</Guard>} />)}
                  </Route>
                ),
                ...(s.routes ?? []).map((r) => <Route key={r.path} path={r.path} element={<Guard access={r.access}>{r.element}</Guard>} />),
              ])}
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
)
