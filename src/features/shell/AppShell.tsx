import {
  BarChart3,
  CalendarDays,
  ClipboardList,
  FileSignature,
  Globe,
  GraduationCap,
  Handshake,
  LayoutTemplate,
  Link2,
  ListChecks,
  ListTodo,
  LogOut,
  type LucideIcon,
  Menu,
  MessageSquare,
  MessagesSquare,
  Megaphone,
  Newspaper,
  Phone,
  Receipt,
  ReceiptText,
  Settings,
  Share2,
  Sparkles,
  Star,
  Tags,
  Target,
  Users,
  Workflow,
  X,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { Avatar } from '../../components/ui/avatar'
import { applyAccent, brandLogoUrl, brandName } from '../../lib/brand'
import { type ModuleKey, moduleEnabled } from '../../lib/modules'
import { cn } from '../../lib/utils'
import { useTenant } from '../../state/location'
import { useAuth } from '../../state/auth'
import { LocationSwitcher } from './LocationSwitcher'

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  soon?: boolean
  /** Hidden when the current location has this module off. Settings has none: always shown. */
  module?: ModuleKey
}

// Conversations + Contacts are live in slice 1; the rest are the GHL surface
// area we're building toward, shown with a "soon" tag (never as working links).
const NAV: NavItem[] = [
  { to: '/assistant', label: 'Assistant', icon: Sparkles, module: 'assistant' },
  { to: '/conversations', label: 'Conversations', icon: MessageSquare, module: 'conversations' },
  { to: '/contacts', label: 'Contacts', icon: Users, module: 'contacts' },
  { to: '/documents', label: 'Documents', icon: FileSignature, module: 'documents' },
  { to: '/billing', label: 'Billing', icon: ReceiptText, module: 'billing' },
  { to: '/tags', label: 'Tags', icon: Tags, module: 'tags' },
  { to: '/opportunities', label: 'Opportunities', icon: Target, module: 'opportunities' },
  { to: '/tasks', label: 'Tasks', icon: ListTodo, module: 'tasks' },
  { to: '/calendars', label: 'Calendars', icon: CalendarDays, module: 'calendars' },
  { to: '/calls', label: 'Calls', icon: Phone, module: 'calls' },
  { to: '/marketing', label: 'Marketing', icon: Megaphone, module: 'marketing' },
  { to: '/templates', label: 'Templates', icon: LayoutTemplate, module: 'templates' },
  { to: '/social', label: 'Social Planner', icon: Share2, module: 'social' },
  { to: '/automations', label: 'Automations', icon: Workflow, module: 'automations' },
  { to: '/reporting', label: 'Dashboard', icon: BarChart3, module: 'reporting' },
  { to: '/sites', label: 'Sites & Funnels', icon: Globe, module: 'sites' },
  { to: '/forms', label: 'Forms', icon: ClipboardList, module: 'forms' },
  { to: '/surveys', label: 'Surveys', icon: ListChecks, module: 'surveys' },
  { to: '/payments', label: 'Payments', icon: Receipt, module: 'payments' },
  { to: '/proposals', label: 'Proposals', icon: FileSignature, module: 'proposals' },
  { to: '/reputation', label: 'Reputation', icon: Star, module: 'reputation' },
  { to: '/memberships', label: 'Memberships', icon: GraduationCap, module: 'memberships' },
  { to: '/communities', label: 'Communities', icon: MessagesSquare, module: 'communities' },
  { to: '/blog', label: 'Blog', icon: Newspaper, module: 'blog' },
  { to: '/trigger-links', label: 'Trigger Links', icon: Link2, module: 'trigger_links' },
  { to: '/affiliates', label: 'Affiliates', icon: Handshake, module: 'affiliates' },
  { to: '/settings', label: 'Settings', icon: Settings },
]

function NavRow({ item }: { item: NavItem }) {
  const base =
    'group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors'
  if (item.soon) {
    return (
      <div className={cn(base, 'cursor-default text-slate-500')} title="Coming soon">
        <item.icon className="h-[18px] w-[18px] text-slate-500" />
        <span className="flex-1">{item.label}</span>
        <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
          soon
        </span>
      </div>
    )
  }
  return (
    <NavLink
      to={item.to}
      className={({ isActive }) =>
        cn(
          base,
          isActive
            ? 'bg-white/10 text-white'
            : 'text-slate-300 hover:bg-white/5 hover:text-white',
        )
      }
    >
      {({ isActive }) => (
        <>
          <item.icon
            className={cn('h-[18px] w-[18px]', isActive ? 'text-brand-300' : 'text-slate-400')}
          />
          <span className="flex-1">{item.label}</span>
        </>
      )}
    </NavLink>
  )
}

/** The practice's logo, or its initials on the accent colour when it has none. */
function Mark({ name, logo, size }: { name: string; logo: string | null; size: 'sm' | 'lg' }) {
  const box = size === 'lg' ? 'h-8 w-8 text-sm' : 'h-7 w-7 text-xs'
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || 'P'
  return logo ? (
    <img src={logo} alt="" className={cn(box, 'shrink-0 rounded-lg bg-white object-contain p-0.5')} />
  ) : (
    <span className={cn(box, 'flex shrink-0 items-center justify-center rounded-lg bg-brand-600 font-bold text-white')} aria-hidden="true">
      {initials}
    </span>
  )
}

/** The persistent app frame: dark sidebar (brand + sub-account switcher + nav +
 *  operator) and a content area that renders the routed page via <Outlet/>.
 *  Below lg the sidebar is an off-canvas drawer behind a hamburger top bar —
 *  a permanently-visible w-64 aside would cover most of a phone screen. */
export function AppShell() {
  const { operator, logout, passwordChangedAt } = useAuth()
  const { current } = useTenant()
  const nav = NAV.filter((item) => !item.module || moduleEnabled(current, item.module))
  const [navOpen, setNavOpen] = useState(false)
  const { pathname } = useLocation()
  const name = brandName(current)
  const logo = brandLogoUrl(current)
  const accent = typeof current?.branding?.color === 'string' ? current.branding.color : null

  // The practice's own look: its accent colour across the app, its name in the browser tab.
  useEffect(() => {
    applyAccent(accent)
    return () => applyAccent(null)
  }, [accent])
  useEffect(() => {
    document.title = name
  }, [name])

  // A nav tap navigates; the drawer must not outlive the page it was opened on.
  useEffect(() => {
    setNavOpen(false)
  }, [pathname])

  return (
    <div className="ol-print-reset flex h-screen w-screen overflow-hidden bg-slate-100">
      {navOpen ? (
        <div
          className="fixed inset-0 z-30 bg-slate-950/60 lg:hidden"
          aria-hidden="true"
          onClick={() => setNavOpen(false)}
        />
      ) : null}

      <aside
        className={cn(
          'ol-noprint fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col bg-slate-900 transition-transform duration-200 lg:static lg:translate-x-0 lg:transition-none',
          navOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex items-center gap-2.5 px-4 pb-3 pt-5">
          <Mark name={name} logo={logo} size="lg" />
          <span className="min-w-0 truncate text-[15px] font-semibold tracking-tight text-white">{name}</span>
          <button
            type="button"
            onClick={() => setNavOpen(false)}
            aria-label="Close menu"
            className="ml-auto rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white/10 hover:text-white lg:hidden"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-3 pb-2">
          <LocationSwitcher />
        </div>

        <nav className="ol-scroll flex-1 space-y-0.5 overflow-y-auto px-3 py-2">
          {nav.map((item) => (
            <NavRow key={item.to} item={item} />
          ))}
        </nav>

        <div className="border-t border-white/10 p-3">
          <div className="flex items-center gap-2.5">
            <Avatar name={operator?.name ?? operator?.email ?? '?'} size="sm" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-white">
                {operator?.name ?? 'Operator'}
              </p>
              <p className="truncate text-xs text-slate-400">{operator?.email}</p>
            </div>
            <button
              type="button"
              onClick={() => void logout()}
              title="Sign out"
              className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>

      <main className="ol-print-reset flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="ol-noprint flex items-center gap-2.5 border-b border-slate-200 bg-white px-3 py-2 lg:hidden">
          <button
            type="button"
            onClick={() => setNavOpen(true)}
            aria-label="Open menu"
            className="rounded-md p-1.5 text-slate-600 transition-colors hover:bg-slate-100"
          >
            <Menu className="h-5 w-5" />
          </button>
          <Mark name={name} logo={logo} size="sm" />
          <span className="min-w-0 truncate text-sm font-semibold tracking-tight text-slate-900">{name}</span>
        </header>
        {passwordChangedAt === null && pathname !== '/settings/account' && (
          <div role="status" className="ol-noprint flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
            <span>You are still using the password this account was created with.</span>
            <Link to="/settings/account" className="font-semibold underline underline-offset-2">Choose your own</Link>
          </div>
        )}
        <Outlet />
      </main>
    </div>
  )
}
