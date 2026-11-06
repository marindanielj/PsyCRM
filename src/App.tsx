import { Navigate, Route, Routes } from 'react-router-dom'
import { Spinner } from './components/ui/spinner'
import { AffiliatesPage } from './features/affiliates/AffiliatesPage'
import { AssistantPage } from './features/assistant/AssistantPage'
import { AuditLogPage } from './features/audit/AuditLogPage'
import { NoteReportPage } from './features/session-notes/NoteReportPage'
import { NoteWizardPage } from './features/session-notes/NoteWizard'
import { AutomationsPage } from './features/automations/AutomationsPage'
import { IdleTimeout } from './features/auth/IdleTimeout'
import { LoginPage } from './features/auth/LoginPage'
import { BlogPage } from './features/blog/BlogPage'
import { CalendarsPage } from './features/calendars/CalendarsPage'
import { CallsPage } from './features/calls/CallsPage'
import { CommunitiesPage } from './features/communities/CommunitiesPage'
import { ContactsPage } from './features/contacts/ContactsPage'
import { InboxPage } from './features/conversations/InboxPage'
import { CustomFieldsPage } from './features/custom-fields/CustomFieldsPage'
import { CustomValuesPage } from './features/custom-values/CustomValuesPage'
import { FormsPage } from './features/forms/FormsPage'
import { MarketingPage } from './features/marketing/MarketingPage'
import { MembershipsPage } from './features/memberships/MembershipsPage'
import { OpportunitiesPage } from './features/opportunities/OpportunitiesPage'
import { CouponsPage } from './features/payments/CouponsPage'
import { PaymentsLayout } from './features/payments/PaymentsLayout'
import { PaymentsPage } from './features/payments/PaymentsPage'
import { ProductsPage } from './features/payments/ProductsPage'
import { SubscriptionsPage } from './features/payments/SubscriptionsPage'
import { TransactionsPage } from './features/payments/TransactionsPage'
import { ProposalsPage } from './features/proposals/ProposalsPage'
import { ReportingPage } from './features/reporting/ReportingPage'
import { ReputationPage } from './features/reputation/ReputationPage'
import { AgentSettingsPage } from './features/settings/AgentSettingsPage'
import { PaymentsSettingsPage } from './features/settings/PaymentsSettingsPage'
import { SendingSettingsPage } from './features/settings/SendingSettingsPage'
import { SocialSettingsPage } from './features/settings/SocialSettingsPage'
import { VoiceSettingsPage } from './features/settings/VoiceSettingsPage'
import { PipelinesSettingsPage } from './features/settings/PipelinesSettingsPage'
import { PracticeSettingsPage } from './features/settings/PracticeSettingsPage'
import { SettingsLayout } from './features/settings/SettingsLayout'
import { AppShell } from './features/shell/AppShell'
import { Landing, RequireModule } from './features/shell/RequireModule'
import { SitesPage } from './features/sites/SitesPage'
import { SocialPage } from './features/social/SocialPage'
import { SurveysPage } from './features/surveys/SurveysPage'
import { TagsPage } from './features/tags/TagsPage'
import { TasksPage } from './features/tasks/TasksPage'
import { TemplatesPage } from './features/templates/TemplatesPage'
import { TriggerLinksPage } from './features/trigger-links/TriggerLinksPage'
import { AuthProvider, useAuth } from './state/auth'
import { TenantProvider } from './state/location'

function FullScreenSpinner() {
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-slate-100">
      <Spinner className="h-7 w-7" />
    </div>
  )
}

/** Auth gate + tenant scope for every signed-in page. Renders the shell (which
 *  has its own <Outlet/>) so the routed page shows inside the frame. */
function ProtectedLayout() {
  const { status } = useAuth()
  if (status === 'loading') return <FullScreenSpinner />
  if (status === 'anon') return <Navigate to="/login" replace />
  return (
    <TenantProvider>
      <AppShell />
      <IdleTimeout />
    </TenantProvider>
  )
}

function LoginRoute() {
  const { status } = useAuth()
  if (status === 'loading') return <FullScreenSpinner />
  if (status === 'authed') return <Navigate to="/" replace />
  return <LoginPage />
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginRoute />} />
        <Route element={<ProtectedLayout />}>
          <Route index element={<Landing />} />
          <Route path="assistant" element={<RequireModule module="assistant"><AssistantPage /></RequireModule>} />
          <Route path="conversations" element={<RequireModule module="conversations"><InboxPage /></RequireModule>} />
          <Route path="conversations/:id" element={<RequireModule module="conversations"><InboxPage /></RequireModule>} />
          <Route path="contacts" element={<RequireModule module="contacts"><ContactsPage /></RequireModule>} />
          <Route path="contacts/:id" element={<RequireModule module="contacts"><ContactsPage /></RequireModule>} />
          <Route path="contacts/:id/notes/new" element={<RequireModule module="session_notes"><NoteWizardPage mode="new" /></RequireModule>} />
          <Route path="contacts/:id/notes/:noteId" element={<RequireModule module="session_notes"><NoteReportPage /></RequireModule>} />
          <Route path="contacts/:id/notes/:noteId/edit" element={<RequireModule module="session_notes"><NoteWizardPage mode="edit" /></RequireModule>} />
          <Route path="tags" element={<RequireModule module="tags"><TagsPage /></RequireModule>} />
          <Route path="settings" element={<SettingsLayout />}>
            <Route index element={<Navigate to="/settings/practice" replace />} />
            <Route path="practice" element={<PracticeSettingsPage />} />
            <Route path="audit" element={<RequireModule module="audit"><AuditLogPage /></RequireModule>} />
            <Route path="pipelines" element={<PipelinesSettingsPage />} />
            <Route path="custom-fields" element={<CustomFieldsPage />} />
            <Route path="custom-values" element={<CustomValuesPage />} />
            <Route path="agent" element={<RequireModule module="assistant"><AgentSettingsPage /></RequireModule>} />
            <Route path="payments" element={<RequireModule module="payments"><PaymentsSettingsPage /></RequireModule>} />
            <Route path="sending" element={<SendingSettingsPage />} />
            <Route path="social" element={<RequireModule module="social"><SocialSettingsPage /></RequireModule>} />
            <Route path="voice" element={<RequireModule module="calls"><VoiceSettingsPage /></RequireModule>} />
          </Route>
          {/* Custom Fields + Custom Values moved under Settings; keep the old
              top-level links working for any saved bookmarks. */}
          <Route path="custom-fields" element={<Navigate to="/settings/custom-fields" replace />} />
          <Route path="custom-values" element={<Navigate to="/settings/custom-values" replace />} />
          <Route path="opportunities" element={<RequireModule module="opportunities"><OpportunitiesPage /></RequireModule>} />
          <Route path="tasks" element={<RequireModule module="tasks"><TasksPage /></RequireModule>} />
          <Route path="calendars" element={<RequireModule module="calendars"><CalendarsPage /></RequireModule>} />
          <Route path="calls" element={<RequireModule module="calls"><CallsPage /></RequireModule>} />
          <Route path="marketing" element={<RequireModule module="marketing"><MarketingPage /></RequireModule>} />
          <Route path="templates" element={<RequireModule module="templates"><TemplatesPage /></RequireModule>} />
          <Route path="social" element={<RequireModule module="social"><SocialPage /></RequireModule>} />
          <Route path="automations" element={<RequireModule module="automations"><AutomationsPage /></RequireModule>} />
          <Route path="reporting" element={<RequireModule module="reporting"><ReportingPage /></RequireModule>} />
          <Route path="sites" element={<RequireModule module="sites"><SitesPage /></RequireModule>} />
          <Route path="forms" element={<RequireModule module="forms"><FormsPage /></RequireModule>} />
          <Route path="surveys" element={<RequireModule module="surveys"><SurveysPage /></RequireModule>} />
          <Route path="payments" element={<RequireModule module="payments"><PaymentsLayout /></RequireModule>}>
            <Route index element={<Navigate to="/payments/invoices" replace />} />
            <Route path="invoices" element={<PaymentsPage />} />
            <Route path="products" element={<ProductsPage />} />
            <Route path="subscriptions" element={<SubscriptionsPage />} />
            <Route path="coupons" element={<CouponsPage />} />
            <Route path="transactions" element={<TransactionsPage />} />
          </Route>
          <Route path="proposals" element={<RequireModule module="proposals"><ProposalsPage /></RequireModule>} />
          <Route path="reputation" element={<RequireModule module="reputation"><ReputationPage /></RequireModule>} />
          <Route path="memberships" element={<RequireModule module="memberships"><MembershipsPage /></RequireModule>} />
          <Route path="communities" element={<RequireModule module="communities"><CommunitiesPage /></RequireModule>} />
          <Route path="blog" element={<RequireModule module="blog"><BlogPage /></RequireModule>} />
          <Route path="trigger-links" element={<RequireModule module="trigger_links"><TriggerLinksPage /></RequireModule>} />
          <Route path="affiliates" element={<RequireModule module="affiliates"><AffiliatesPage /></RequireModule>} />
          <Route path="*" element={<Landing />} />
        </Route>
      </Routes>
    </AuthProvider>
  )
}
