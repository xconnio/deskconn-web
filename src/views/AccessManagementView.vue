<script setup lang="ts">
import { ref, watch, onUnmounted, computed } from 'vue'
import { useAuthStore } from '../stores/auth'
import { useMachinesStore } from '../stores/machines'
import { authService } from '../services/authService'
import type { Organization, DesktopInvite, OrganizationInvite } from '../types'
import MachineAccessView from './MachineAccessView.vue'
import OrganizationDetailView from './OrganizationDetailView.vue'

const authStore = useAuthStore()
const machinesStore = useMachinesStore()

// Only ever rendered inside AccountPanel's popup — drills into a machine's
// or organization's detail page in place instead of navigating to a
// separate route (which would just close the popup).
const selectedMachineId = ref<string | null>(null)
function openMachineAccess(id: string) {
  selectedMachineId.value = id
}

const selectedOrgId = ref<string | null>(null)
function openOrgDetail(id: string) {
  selectedOrgId.value = id
}

// --- Organizations ---
const organizations = ref<Organization[]>([])
const isLoadingOrgs = ref(false)
const showCreateOrgModal = ref(false)
const newOrgName = ref('')
const isCreatingOrg = ref(false)
const createOrgError = ref('')

// --- Desktop Invitations ---
const invitations = ref<DesktopInvite[]>([])
const isLoadingInvitations = ref(false)
const respondingId = ref<string | null>(null)
const respondError = ref('')

// --- Org Invitations ---
const orgInvitations = ref<OrganizationInvite[]>([])
const isLoadingOrgInvitations = ref(false)
const respondingOrgId = ref<string | null>(null)
const respondOrgError = ref('')

// Each area gets its own tab rather than stacking every list in one scroll.
type AccessTab = 'machines' | 'organizations' | 'invitations'
const tabs: { id: AccessTab; label: string; icon: string }[] = [
  { id: 'machines', label: 'Machines', icon: 'bi-pc-display' },
  { id: 'organizations', label: 'Organizations', icon: 'bi-building' },
  { id: 'invitations', label: 'Invitations', icon: 'bi-envelope' },
]
const activeTab = ref<AccessTab>('machines')

// --- Computed ---
const pendingInviteCount = computed(() => invitations.value.length + orgInvitations.value.length)
const accessibleMachines = computed(() =>
  machinesStore.desktops.filter((d) => d.role === 'owner' || d.role === 'admin'),
)

// --- Fetch ---
const fetchOrganizations = async () => {
  if (!authStore.session) return
  isLoadingOrgs.value = true
  try {
    const result = await authService.listOrganizations(authStore.session)
    organizations.value = result.args as Organization[]
  } catch (err) {
    console.error('Failed to fetch organizations', err)
  } finally {
    isLoadingOrgs.value = false
  }
}

const fetchInvitations = async () => {
  if (!authStore.session) return
  isLoadingInvitations.value = true
  respondError.value = ''
  try {
    const result = await authService.listDesktopInvitesInbox(authStore.session)
    invitations.value = result.args as DesktopInvite[]
  } catch (err) {
    console.error('Failed to fetch desktop invitations', err)
  } finally {
    isLoadingInvitations.value = false
  }
}

const fetchOrgInvitations = async () => {
  if (!authStore.session) return
  isLoadingOrgInvitations.value = true
  respondOrgError.value = ''
  try {
    const result = await authService.listOrgInvitesInbox(authStore.session)
    orgInvitations.value = result.args as OrganizationInvite[]
  } catch (err) {
    console.error('Failed to fetch org invitations', err)
  } finally {
    isLoadingOrgInvitations.value = false
  }
}

watch(
  () => authStore.session,
  (session) => {
    if (session) {
      fetchOrganizations()
      fetchInvitations()
      fetchOrgInvitations()
    }
  },
  { immediate: true },
)

// --- Create org ---
const handleCreateOrgEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') closeCreateOrgModal() }
watch(showCreateOrgModal, (open) => {
  if (open) document.addEventListener('keydown', handleCreateOrgEsc)
  else document.removeEventListener('keydown', handleCreateOrgEsc)
})
onUnmounted(() => document.removeEventListener('keydown', handleCreateOrgEsc))

const closeCreateOrgModal = () => {
  showCreateOrgModal.value = false
  newOrgName.value = ''
  createOrgError.value = ''
}

const handleCreateOrg = async () => {
  if (!authStore.session || !newOrgName.value.trim()) return
  isCreatingOrg.value = true
  createOrgError.value = ''
  try {
    await authService.createOrganization(authStore.session, newOrgName.value.trim())
    await fetchOrganizations()
    closeCreateOrgModal()
  } catch (err) {
    createOrgError.value = err instanceof Error ? err.message : 'Failed to create organization'
  } finally {
    isCreatingOrg.value = false
  }
}

// --- Respond to org invite ---
const handleRespondOrg = async (invite: OrganizationInvite, status: 'accepted' | 'rejected') => {
  if (!authStore.session) return
  respondingOrgId.value = invite.id
  respondOrgError.value = ''
  try {
    await authService.respondToOrgInvite(authStore.session, invite.id, status)
    orgInvitations.value = orgInvitations.value.filter((i) => i.id !== invite.id)
  } catch (err) {
    respondOrgError.value = err instanceof Error ? err.message : 'Failed to respond to invitation'
  } finally {
    respondingOrgId.value = null
  }
}

// --- Respond to desktop invite ---
const handleRespond = async (invite: DesktopInvite, status: 'accepted' | 'rejected') => {
  if (!authStore.session) return
  respondingId.value = invite.id
  respondError.value = ''
  try {
    await authService.respondToDesktopInvite(authStore.session, invite.id, status)
    invitations.value = invitations.value.filter((i) => i.id !== invite.id)
    if (status === 'accepted') {
      await machinesStore.fetchMachines(authStore.session, true)
    }
  } catch (err) {
    respondError.value = err instanceof Error ? err.message : 'Failed to respond to invitation'
  } finally {
    respondingId.value = null
  }
}
</script>

<template>
  <div class="container py-0">
    <div class="row justify-content-center">
      <div class="col-lg-10">

        <template v-if="!selectedMachineId && !selectedOrgId">

        <ul class="nav nav-underline access-tabs mb-3" role="tablist">
          <li v-for="t in tabs" :key="t.id" class="nav-item" role="presentation">
            <button
              class="nav-link d-flex align-items-center gap-2"
              :class="{ active: activeTab === t.id }"
              role="tab"
              :aria-selected="activeTab === t.id"
              @click="activeTab = t.id"
            >
              <i class="bi" :class="t.icon"></i> {{ t.label }}
              <span v-if="t.id === 'invitations' && pendingInviteCount" class="badge rounded-pill bg-danger">
                {{ pendingInviteCount }}
              </span>
            </button>
          </li>
        </ul>

        <!-- ── Machines ── -->
        <div v-if="activeTab === 'machines'">
          <p class="text-muted small mb-3">Pick a machine to manage who can access it.</p>

          <div v-if="machinesStore.isLoadingDesktops" class="text-center py-3">
            <div class="spinner-border spinner-border-sm text-primary" role="status">
              <span class="visually-hidden">Loading...</span>
            </div>
          </div>

          <div v-else class="card border-0 shadow-sm">
            <ul class="list-group list-group-flush rounded-3">
              <li
                v-for="m in accessibleMachines"
                :key="m.id"
                class="list-group-item border-0 px-3 py-2 access-row"
                @click="openMachineAccess(m.id)"
              >
                <div class="d-flex align-items-center gap-3">
                  <div class="avatar-circle avatar-machine">{{ m.icon }}</div>
                  <div class="flex-grow-1 min-w-0">
                    <div class="fw-semibold text-truncate">{{ m.name }}</div>
                  </div>
                  <span
                    class="badge bg-light border text-capitalize flex-shrink-0"
                    :class="m.role === 'owner' ? 'text-success border-success-subtle' : 'text-primary border-primary-subtle'"
                  >{{ m.role }}</span>
                  <i class="bi bi-chevron-right text-muted flex-shrink-0"></i>
                </div>
              </li>
              <li v-if="accessibleMachines.length === 0" class="list-group-item border-0 text-center text-muted py-4 small">
                You don't have access to any machines yet.
              </li>
            </ul>
          </div>
        </div>

        <!-- ── Organizations ── -->
        <div v-else-if="activeTab === 'organizations'">
          <div class="d-flex justify-content-between align-items-center mb-3">
            <p class="text-muted small mb-0">Group people into organizations and share machines with them.</p>
            <button
              class="btn btn-primary btn-sm rounded-pill btn-compact shadow-none no-underline-hover flex-shrink-0 text-nowrap"
              @click="showCreateOrgModal = true"
            >
              <i class="bi bi-plus-lg me-1"></i> Add New
            </button>
          </div>

          <div v-if="isLoadingOrgs" class="text-center py-3">
            <div class="spinner-border spinner-border-sm text-primary" role="status">
              <span class="visually-hidden">Loading...</span>
            </div>
          </div>

          <div v-else class="card border-0 shadow-sm">
            <ul class="list-group list-group-flush rounded-3">
              <li
                v-for="org in organizations"
                :key="org.id"
                class="list-group-item border-0 px-3 py-2 access-row"
                @click="openOrgDetail(org.id)"
              >
                <div class="d-flex align-items-center gap-3">
                  <div class="avatar-circle avatar-org">
                    <i class="bi bi-building"></i>
                  </div>
                  <div class="flex-grow-1 min-w-0">
                    <div class="fw-semibold text-truncate">{{ org.name }}</div>
                  </div>
                  <i class="bi bi-chevron-right text-muted flex-shrink-0"></i>
                </div>
              </li>
              <li v-if="organizations.length === 0" class="list-group-item border-0 text-center text-muted py-4 small">
                No organizations found. Create your first one!
              </li>
            </ul>
          </div>
        </div>

        <!-- ── Invitations ── -->
        <div v-else>
          <p class="text-muted small mb-3">Invitations other people have sent you to join their machines and organizations.</p>

          <div v-if="respondError || respondOrgError" class="alert alert-danger d-flex align-items-center mb-3 py-2" role="alert">
            <i class="bi bi-exclamation-triangle-fill me-2"></i>{{ respondError || respondOrgError }}
          </div>

          <div v-if="isLoadingInvitations || isLoadingOrgInvitations" class="text-center py-3">
            <div class="spinner-border spinner-border-sm text-primary" role="status"></div>
          </div>

          <div v-else-if="pendingInviteCount === 0" class="card border-dashed p-4 text-center bg-transparent">
            <i class="bi bi-envelope-open text-muted fs-4 mb-2"></i>
            <p class="text-muted small mb-0">You're all caught up. No pending invitations.</p>
          </div>

          <div v-else class="card border-0 shadow-sm">
            <div class="list-group list-group-flush rounded-3">
              <div v-for="invite in invitations" :key="invite.id" class="list-group-item border-0 px-3 py-2">
                <div class="d-flex align-items-center justify-content-between gap-3 flex-wrap">
                  <div class="d-flex align-items-center gap-3 min-w-0">
                    <div class="invite-icon invite-icon-sm">
                      <i class="bi bi-pc-display fs-5 text-primary"></i>
                    </div>
                    <div class="min-w-0">
                      <div class="fw-semibold text-dark text-truncate">{{ invite.desktop?.name ?? 'A machine' }}</div>
                      <div class="text-muted small">
                        Machine · <span class="text-capitalize">{{ invite.role }}</span> access
                      </div>
                    </div>
                  </div>
                  <div class="d-flex gap-2 flex-shrink-0">
                    <button
                      class="btn btn-sm btn-outline-success rounded-pill px-3"
                      :disabled="respondingId === invite.id"
                      @click="handleRespond(invite, 'accepted')"
                    >
                      <span v-if="respondingId === invite.id" class="spinner-border spinner-border-sm me-1"></span>
                      Accept
                    </button>
                    <button
                      class="btn btn-sm btn-outline-danger rounded-pill px-3"
                      :disabled="respondingId === invite.id"
                      @click="handleRespond(invite, 'rejected')"
                    >
                      Decline
                    </button>
                  </div>
                </div>
              </div>

              <div v-for="invite in orgInvitations" :key="invite.id" class="list-group-item border-0 px-3 py-2">
                <div class="d-flex align-items-center justify-content-between gap-3 flex-wrap">
                  <div class="d-flex align-items-center gap-3 min-w-0">
                    <div class="invite-icon invite-icon-sm">
                      <i class="bi bi-building fs-5 text-primary"></i>
                    </div>
                    <div class="min-w-0">
                      <div class="fw-semibold text-dark text-truncate">{{ invite.organization?.name ?? 'An organization' }}</div>
                      <div class="text-muted small">
                        Organization · <span class="text-capitalize">{{ invite.role }}</span>
                      </div>
                    </div>
                  </div>
                  <div class="d-flex gap-2 flex-shrink-0">
                    <button
                      class="btn btn-sm btn-outline-success rounded-pill px-3"
                      :disabled="respondingOrgId === invite.id"
                      @click="handleRespondOrg(invite, 'accepted')"
                    >
                      <span v-if="respondingOrgId === invite.id" class="spinner-border spinner-border-sm me-1"></span>
                      Accept
                    </button>
                    <button
                      class="btn btn-sm btn-outline-danger rounded-pill px-3"
                      :disabled="respondingOrgId === invite.id"
                      @click="handleRespondOrg(invite, 'rejected')"
                    >
                      Decline
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        </template>

        <MachineAccessView
          v-else-if="selectedMachineId"
          :key="selectedMachineId"
          :machine-id="selectedMachineId"
          @back="selectedMachineId = null"
          @open-org="(id) => { selectedMachineId = null; selectedOrgId = id }"
        />

        <OrganizationDetailView
          v-else-if="selectedOrgId"
          :key="selectedOrgId"
          :org-id="selectedOrgId"
          @back="selectedOrgId = null"
        />

      </div>
    </div>
  </div>

  <!-- Create organization modal -->
  <div v-if="showCreateOrgModal" class="modal-overlay" @click.self="closeCreateOrgModal">
    <div class="modal-dialog modal-dialog-centered">
      <div class="modal-content card shadow-lg border-0 glass-modal fade-in-up">
        <div class="modal-header border-0 p-4 pb-0">
          <h4 class="modal-title fw-bold">Add New Organization</h4>
          <button type="button" class="btn-close shadow-none" @click="closeCreateOrgModal"></button>
        </div>
        <div class="modal-body p-4 py-5">
          <div class="mb-2">
            <label class="form-label mb-2">Organization Name</label>
            <input
              v-model="newOrgName"
              type="text"
              class="form-control form-control-lg theme-input"
              placeholder="Enter organization name"
              autofocus
              @keyup.enter="handleCreateOrg"
            />
          </div>
          <div v-if="createOrgError" class="text-danger small mt-2 d-flex align-items-center">
            <i class="bi bi-exclamation-circle me-1"></i> {{ createOrgError }}
          </div>
        </div>
        <div class="modal-footer border-0 p-4 pt-0">
          <button
            type="button"
            class="btn btn-link text-muted text-decoration-none fw-semibold me-auto"
            @click="closeCreateOrgModal"
          >
            Cancel
          </button>
          <button
            type="button"
            class="btn btn-theme-primary rounded-pill px-5 py-2 fw-bold"
            :disabled="!newOrgName.trim() || isCreatingOrg"
            @click="handleCreateOrg"
          >
            <span v-if="isCreatingOrg" class="spinner-border spinner-border-sm me-2"></span>
            {{ isCreatingOrg ? 'Creating...' : 'Create' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.card-hover-static {
  transition: box-shadow 0.2s ease;
}

.card-hover-static:hover {
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.08) !important;
}

.border-dashed {
  border: 2px dashed #e2e8f0 !important;
  border-radius: 12px;
}

.invite-icon {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: #eff6ff;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.invite-icon-sm {
  width: 32px;
  height: 32px;
}

.invite-icon-sm i {
  font-size: 0.85rem;
}

.avatar-circle {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.95rem;
  flex-shrink: 0;
}

.avatar-machine {
  background: #eef2f6;
}

.avatar-org {
  background: #eff6ff;
  color: #2563eb;
}

.access-row {
  cursor: pointer;
  transition: background 0.15s ease;
}

.access-row:hover {
  background: #f8fafc;
}

.no-underline-hover:hover {
  text-decoration: none !important;
  background-color: var(--theme-primary-hover) !important;
  color: white !important;
}

.min-w-0 {
  min-width: 0;
}
</style>
