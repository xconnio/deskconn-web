<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue'
import { useAuthStore } from '../stores/auth'
import { useMachinesStore } from '../stores/machines'
import { authService } from '../services/authService'
import type { DesktopUserAccess, DesktopOrganizationAccess, Organization, DesktopInvite } from '../types'
import { ApplicationError } from 'xconn'

// Only ever rendered as a drill-down inside AccountPanel's popup Machines
// list — takes `machineId` as a prop and emits `back`/`open-org` instead of
// routing to a separate page.
const props = defineProps<{ machineId: string }>()
const emit = defineEmits<{ back: []; 'open-org': [id: string] }>()

const authStore = useAuthStore()
const machinesStore = useMachinesStore()

const machineId = props.machineId

const machine = computed(() => machinesStore.desktops.find((d) => d.id === machineId))

// --- My access (to determine admin/owner status) ---
const myAccess = ref<DesktopUserAccess | null>(null)
const isAdminOrOwner = computed(() =>
  myAccess.value?.role === 'owner' || myAccess.value?.role === 'admin',
)

// --- People (user accesses) ---
const userAccesses = ref<DesktopUserAccess[]>([])
const isLoadingUsers = ref(false)
const updatingUserId = ref<string | null>(null)
const revokingUserId = ref<string | null>(null)

// --- Teams (org accesses) ---
const orgAccesses = ref<DesktopOrganizationAccess[]>([])
const isLoadingOrgs = ref(false)
const revokingOrgId = ref<string | null>(null)

// --- Invite user modal ---
const showInviteModal = ref(false)
const inviteEmail = ref('')
const inviteRole = ref<'admin' | 'member'>('member')
const isInviting = ref(false)
const inviteError = ref('')
const inviteSuccessToast = ref(false)

// --- Pending invitations ---
const pendingInvites = ref<DesktopInvite[]>([])
const isLoadingInvites = ref(false)
const cancelingInviteId = ref<string | null>(null)

// --- Add org modal ---
const showOrgModal = ref(false)
const organizations = ref<Organization[]>([])
const selectedOrgId = ref('')
const isAddingOrg = ref(false)
const addOrgError = ref('')
const isLoadingOrgList = ref(false)

// Collaborators, teams and sent invites each get their own tab instead of
// stacking three lists in one scroll. Sent invites only matter to admins.
type MachineTab = 'people' | 'teams' | 'invites'
const activeTab = ref<MachineTab>('people')
const tabs = computed(() => [
  { id: 'people' as const, label: 'Collaborators', icon: 'bi-people', count: userAccesses.value.length },
  { id: 'teams' as const, label: 'Teams', icon: 'bi-building', count: orgAccesses.value.length },
  ...(isAdminOrOwner.value
    ? [{ id: 'invites' as const, label: 'Sent invites', icon: 'bi-send', count: pendingInvites.value.length }]
    : []),
])

const fetchAll = async () => {
  if (!authStore.session) return
  await Promise.all([fetchMyAccess(), fetchUserAccesses(), fetchOrgAccesses()])
}

const fetchMyAccess = async () => {
  if (!authStore.session) return
  try {
    const result = await authService.getMyDesktopAccess(authStore.session, machineId)
    myAccess.value = result.args[0] as DesktopUserAccess
  } catch {
    myAccess.value = null
  }
}

const fetchPendingInvites = async () => {
  if (!authStore.session) return
  isLoadingInvites.value = true
  try {
    const result = await authService.listDesktopInvitesOutbox(authStore.session)
    pendingInvites.value = (result.args as DesktopInvite[]).filter(
      (inv) => inv.desktop_id === machineId,
    )
  } catch (err) {
    console.error('Failed to fetch pending invites', err)
  } finally {
    isLoadingInvites.value = false
  }
}

const fetchUserAccesses = async () => {
  if (!authStore.session) return
  isLoadingUsers.value = true
  try {
    const result = await authService.listDesktopUserAccesses(authStore.session, machineId)
    userAccesses.value = result.args as DesktopUserAccess[]
  } catch (err) {
    console.error('Failed to fetch user accesses', err)
  } finally {
    isLoadingUsers.value = false
  }
}

const fetchOrgAccesses = async () => {
  if (!authStore.session) return
  isLoadingOrgs.value = true
  try {
    const result = await authService.listDesktopOrgAccesses(authStore.session, machineId)
    orgAccesses.value = result.args as DesktopOrganizationAccess[]
  } catch (err) {
    console.error('Failed to fetch org accesses', err)
  } finally {
    isLoadingOrgs.value = false
  }
}

watch(
  () => authStore.session,
  (session) => {
    if (session) fetchAll()
  },
  { immediate: true },
)

watch(isAdminOrOwner, (adminOrOwner) => {
  if (adminOrOwner) fetchPendingInvites()
})

// --- Role update handlers ---
const handleUserRoleChange = async (access: DesktopUserAccess, newRole: string) => {
  if (!authStore.session || newRole === access.role) return
  updatingUserId.value = access.id
  try {
    await authService.updateUserAccessRole(authStore.session, access.id, newRole)
    access.role = newRole as DesktopUserAccess['role']
  } catch (err) {
    console.error('Failed to update user role', err)
    await fetchUserAccesses()
  } finally {
    updatingUserId.value = null
  }
}

// --- Revoke access ---
const handleRevokeUser = async (access: DesktopUserAccess) => {
  if (!authStore.session) return
  revokingUserId.value = access.id
  try {
    await authService.revokeUserAccess(authStore.session, access.id)
    userAccesses.value = userAccesses.value.filter((a) => a.id !== access.id)
  } catch (err) {
    console.error('Failed to revoke user access', err)
  } finally {
    revokingUserId.value = null
  }
}

const handleRevokeOrg = async (access: DesktopOrganizationAccess) => {
  if (!authStore.session) return
  revokingOrgId.value = access.id
  try {
    await authService.revokeOrgAccess(authStore.session, access.id)
    orgAccesses.value = orgAccesses.value.filter((a) => a.id !== access.id)
  } catch (err) {
    console.error('Failed to revoke org access', err)
  } finally {
    revokingOrgId.value = null
  }
}

const parseErrorArgs = (args: unknown): string => {
  const str = String(args)
  try {
    const parsed = JSON.parse(str)
    if (Array.isArray(parsed)) return parsed.map((a: { msg?: string }) => a.msg ?? String(a)).join('; ')
  } catch {}
  return str
}

// --- Invite user ---
const openInviteModal = () => {
  inviteEmail.value = ''
  inviteRole.value = 'member'
  inviteError.value = ''
  showInviteModal.value = true
}

const closeInviteModal = () => {
  showInviteModal.value = false
}

const handleInviteUser = async () => {
  if (!authStore.session || !inviteEmail.value.trim()) return
  isInviting.value = true
  inviteError.value = ''
  try {
    await authService.inviteUserToDesktop(authStore.session, machineId, inviteEmail.value, inviteRole.value)
    closeInviteModal()
    await fetchPendingInvites()
    activeTab.value = 'invites' // show where the new invite landed
    inviteSuccessToast.value = true
    setTimeout(() => { inviteSuccessToast.value = false }, 3000)
  } catch (err) {
    if (err instanceof ApplicationError) {
      inviteError.value = parseErrorArgs(err.args)
    } else {
      inviteError.value = 'Failed to send invitation'
    }
  } finally {
    isInviting.value = false
  }
}

const handleInviteEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') closeInviteModal() }
watch(showInviteModal, (open) => {
  if (open) document.addEventListener('keydown', handleInviteEsc)
  else document.removeEventListener('keydown', handleInviteEsc)
})

const handleOrgEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') closeOrgModal() }
watch(showOrgModal, (open) => {
  if (open) document.addEventListener('keydown', handleOrgEsc)
  else document.removeEventListener('keydown', handleOrgEsc)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleInviteEsc)
  document.removeEventListener('keydown', handleOrgEsc)
})

// --- Cancel invite ---
const handleCancelInvite = async (inviteId: string) => {
  if (!authStore.session) return
  cancelingInviteId.value = inviteId
  try {
    await authService.cancelDesktopInvite(authStore.session, inviteId)
    pendingInvites.value = pendingInvites.value.filter((inv) => inv.id !== inviteId)
  } catch {
    await fetchPendingInvites()
  } finally {
    cancelingInviteId.value = null
  }
}

// --- Add org ---
const openOrgModal = async () => {
  selectedOrgId.value = ''
  addOrgError.value = ''
  showOrgModal.value = true
  if (!authStore.session) return
  isLoadingOrgList.value = true
  try {
    const result = await authService.listOrganizations(authStore.session)
    organizations.value = result.args as Organization[]
  } catch (err) {
    console.error('Failed to fetch organizations', err)
  } finally {
    isLoadingOrgList.value = false
  }
}

const closeOrgModal = () => {
  showOrgModal.value = false
}

const handleAddOrg = async () => {
  if (!authStore.session || !selectedOrgId.value) return
  isAddingOrg.value = true
  addOrgError.value = ''
  try {
    await authService.grantOrgDesktopAccess(authStore.session, machineId, selectedOrgId.value)
    await fetchOrgAccesses()
    closeOrgModal()
  } catch (err) {
    addOrgError.value = err instanceof Error ? err.message : 'Failed to grant access'
  } finally {
    isAddingOrg.value = false
  }
}

const avatarInitial = (user?: { name?: string; email?: string }) => {
  return user?.name?.charAt(0)?.toUpperCase() ?? user?.email?.charAt(0)?.toUpperCase() ?? '?'
}

const userDisplayName = (access: DesktopUserAccess) => {
  return access.user?.name ?? access.user?.email ?? access.user_id
}

const userSubtitle = (access: DesktopUserAccess) => {
  if (access.user?.name && access.user?.email) return access.user.email
  return null
}
</script>

<template>
  <div class="container py-0">
    <div v-if="inviteSuccessToast" class="alert alert-success d-flex align-items-center py-2 small position-fixed top-0 start-50 translate-middle-x mt-3 shadow" style="z-index:1100;min-width:260px" role="alert">
      <i class="bi bi-check-circle-fill me-2"></i> Invitation sent successfully!
    </div>
    <div class="row justify-content-center">
      <div class="col-12">

        <!-- Back -->
        <button
          type="button"
          class="btn btn-link text-decoration-none text-muted p-0 d-flex align-items-center back-link back-link-sm mb-3"
          @click="emit('back')"
        >
          <i class="bi bi-arrow-left-short fs-4 me-1"></i>
          <span class="fw-semibold">Back to Machines</span>
        </button>

        <!-- Header -->
        <div class="d-flex align-items-center gap-3 mb-3">
          <span class="machine-hero-icon">🖥️</span>
          <div>
            <h2 class="mb-0 fw-bold fs-5">{{ machine?.name ?? machineId }}</h2>
            <p class="text-muted mb-0 access-subtext">Manage collaborators and team access</p>
          </div>
        </div>

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
              <span v-if="t.count" class="badge rounded-pill bg-secondary">{{ t.count }}</span>
            </button>
          </li>
        </ul>

        <!-- ── Collaborators (People) ── -->
        <section v-if="activeTab === 'people'">
          <div class="d-flex justify-content-between align-items-center gap-3 mb-3">
            <p class="text-muted mb-0 access-subtext">People who have direct access to this machine.</p>
            <button
              v-if="isAdminOrOwner"
              class="btn btn-sm btn-outline-primary rounded-pill btn-compact flex-shrink-0 text-nowrap"
              @click="openInviteModal"
            >
              <i class="bi bi-person-plus me-1"></i> Invite collaborator
            </button>
          </div>

          <div class="card border-0 shadow-sm">
            <div v-if="isLoadingUsers" class="text-center py-4">
              <div class="spinner-border spinner-border-sm text-primary" role="status"></div>
            </div>

            <div v-else-if="userAccesses.length === 0" class="text-center text-muted py-4 small">
              No collaborators yet.
            </div>

            <ul v-else class="list-group list-group-flush rounded-3">
              <li
                v-for="access in userAccesses"
                :key="access.id"
                class="list-group-item border-0 collaborator-row px-3 py-2"
              >
                <div class="d-flex align-items-center gap-3">
                  <!-- Avatar -->
                  <div class="avatar-circle avatar-circle-sm" :class="access.role === 'owner' ? 'avatar-owner' : 'avatar-member'">
                    {{ avatarInitial(access.user) }}
                  </div>

                  <!-- Name + email -->
                  <div class="flex-grow-1 min-w-0">
                    <div class="fw-semibold text-truncate">{{ userDisplayName(access) }}</div>
                    <div v-if="userSubtitle(access)" class="text-muted small text-truncate">
                      {{ userSubtitle(access) }}
                    </div>
                  </div>

                  <!-- Role + remove -->
                  <div class="d-flex align-items-center gap-2 flex-shrink-0">
                    <div v-if="updatingUserId === access.id || revokingUserId === access.id" class="spinner-border spinner-border-sm text-primary"></div>
                    <span v-if="access.role === 'owner'" class="badge bg-dark rounded-pill px-2 py-1">
                      Owner
                    </span>
                    <template v-else-if="isAdminOrOwner">
                      <select
                        class="form-select form-select-sm role-select role-select-sm"
                        :value="access.role"
                        :disabled="updatingUserId === access.id || revokingUserId === access.id"
                        @change="handleUserRoleChange(access, ($event.target as HTMLSelectElement).value)"
                      >
                        <option value="admin">Admin</option>
                        <option value="member">Member</option>
                      </select>
                      <button
                        class="btn btn-sm btn-outline-danger rounded-pill px-2"
                        :disabled="revokingUserId === access.id"
                        title="Remove collaborator"
                        @click="handleRevokeUser(access)"
                      >
                        <i class="bi bi-person-dash"></i>
                      </button>
                    </template>
                    <template v-else>
                      <span class="badge bg-light text-dark border text-capitalize">{{ access.role }}</span>
                    </template>
                  </div>
                </div>
              </li>
            </ul>
          </div>
        </section>

        <!-- ── Pending Invitations ── -->
        <section v-else-if="activeTab === 'invites'">
          <p class="text-muted mb-3 access-subtext">Invitations you've sent that haven't been answered yet.</p>

          <div v-if="isLoadingInvites" class="text-center py-4">
            <div class="spinner-border spinner-border-sm text-primary" role="status"></div>
          </div>

          <div v-else-if="pendingInvites.length === 0" class="card border-dashed p-4 text-center bg-transparent">
            <p class="text-muted small mb-0">No invitations waiting for a response.</p>
          </div>

          <div v-else class="card border-0 shadow-sm">
            <ul class="list-group list-group-flush rounded-3">
              <li
                v-for="invite in pendingInvites"
                :key="invite.id"
                class="list-group-item border-0 px-3 py-2"
              >
                <div class="d-flex align-items-center gap-3">
                  <div class="avatar-circle avatar-circle-sm avatar-member">
                    {{ invite.invitee_user?.name?.charAt(0)?.toUpperCase() ?? invite.invitee_user?.email?.charAt(0)?.toUpperCase() ?? '?' }}
                  </div>
                  <div class="flex-grow-1 min-w-0">
                    <div class="fw-semibold text-truncate">{{ invite.invitee_user?.name ?? invite.invitee_user?.email ?? 'Unknown' }}</div>
                    <div class="text-muted small">
                      Invited as <span class="badge bg-light text-dark border ms-1 text-capitalize">{{ invite.role }}</span>
                    </div>
                  </div>
                  <div class="d-flex align-items-center gap-2 flex-shrink-0">
                    <span class="badge bg-warning-subtle text-warning border border-warning-subtle">Pending</span>
                    <button
                      class="btn btn-sm btn-outline-danger rounded-pill px-2"
                      :disabled="cancelingInviteId === invite.id"
                      title="Cancel invitation"
                      @click="handleCancelInvite(invite.id)"
                    >
                      <span v-if="cancelingInviteId === invite.id" class="spinner-border spinner-border-sm"></span>
                      <i v-else class="bi bi-x-lg"></i>
                    </button>
                  </div>
                </div>
              </li>
            </ul>
          </div>
        </section>

        <!-- ── Teams (Organizations) ── -->
        <section v-else>
          <div class="d-flex justify-content-between align-items-center gap-3 mb-3">
            <p class="text-muted mb-0 access-subtext">Organizations with access. All of their members can use this machine.</p>
            <button
              v-if="isAdminOrOwner"
              class="btn btn-sm btn-outline-primary rounded-pill btn-compact flex-shrink-0 text-nowrap"
              @click="openOrgModal"
            >
              <i class="bi bi-building-add me-1"></i> Add a team
            </button>
          </div>

          <div class="card border-0 shadow-sm">
            <div v-if="isLoadingOrgs" class="text-center py-4">
              <div class="spinner-border spinner-border-sm text-primary" role="status"></div>
            </div>

            <div v-else-if="orgAccesses.length === 0" class="text-center text-muted py-4 small">
              No teams have access yet.
            </div>

            <ul v-else class="list-group list-group-flush rounded-3">
              <li
                v-for="access in orgAccesses"
                :key="access.id"
                class="list-group-item border-0 collaborator-row org-row px-3 py-2"
                @click="emit('open-org', access.organization_id)"
              >
                <div class="d-flex align-items-center gap-3">
                  <div class="avatar-circle avatar-circle-sm avatar-org">
                    <i class="bi bi-building text-primary"></i>
                  </div>
                  <div class="flex-grow-1 min-w-0">
                    <div class="fw-semibold text-truncate">
                      {{ access.organization?.name ?? access.organization_id }}
                    </div>
                    <div class="text-muted small">
                      <span class="badge bg-light text-dark border text-capitalize me-1">{{ access.role }}</span>
                      · Click to manage members
                    </div>
                  </div>
                  <div class="d-flex align-items-center gap-2 flex-shrink-0" @click.stop>
                    <template v-if="isAdminOrOwner">
                      <div v-if="revokingOrgId === access.id" class="spinner-border spinner-border-sm text-primary"></div>
                      <button
                        v-else
                        class="btn btn-sm btn-outline-danger rounded-pill px-2"
                        :disabled="revokingOrgId === access.id"
                        title="Remove team"
                        @click.stop="handleRevokeOrg(access)"
                      >
                        <i class="bi bi-building-dash"></i>
                      </button>
                    </template>
                    <i class="bi bi-chevron-right text-muted"></i>
                  </div>
                </div>
              </li>
            </ul>
          </div>
        </section>

      </div>
    </div>
  </div>

  <!-- ── Invite collaborator modal ── -->
  <div v-if="showInviteModal" class="modal-overlay" @click.self="closeInviteModal">
    <div class="modal-dialog modal-dialog-centered">
      <div class="modal-content card shadow-lg border-0 glass-modal fade-in-up">
        <div class="modal-header border-0 p-4 pb-0">
          <h4 class="modal-title fw-bold">Invite a collaborator</h4>
          <button type="button" class="btn-close shadow-none" @click="closeInviteModal"></button>
        </div>

        <div class="modal-body p-4">
          <div class="mb-3">
            <label class="form-label fw-semibold small">Email address</label>
            <input
              v-model="inviteEmail"
              type="email"
              class="form-control theme-input"
              placeholder="user@example.com"
              autofocus
              @keyup.enter="handleInviteUser"
            />
          </div>

          <div class="mb-3">
            <label class="form-label fw-semibold small">Role</label>
            <div class="d-flex gap-3">
              <label class="role-option flex-fill" :class="{ selected: inviteRole === 'member' }">
                <input type="radio" v-model="inviteRole" value="member" class="visually-hidden" />
                <div class="p-3 rounded-3 border text-center cursor-pointer">
                  <i class="bi bi-person fs-4 d-block mb-1 text-muted"></i>
                  <div class="fw-semibold small">Member</div>
                  <div class="text-muted" style="font-size: 0.75rem">Read & connect</div>
                </div>
              </label>
              <label class="role-option flex-fill" :class="{ selected: inviteRole === 'admin' }">
                <input type="radio" v-model="inviteRole" value="admin" class="visually-hidden" />
                <div class="p-3 rounded-3 border text-center cursor-pointer">
                  <i class="bi bi-shield-check fs-4 d-block mb-1 text-muted"></i>
                  <div class="fw-semibold small">Admin</div>
                  <div class="text-muted" style="font-size: 0.75rem">Full management</div>
                </div>
              </label>
            </div>
          </div>

          <div v-if="inviteError" class="alert alert-danger d-flex align-items-center justify-content-between py-2 small mb-0" role="alert">
            <span><i class="bi bi-exclamation-circle-fill me-2"></i>{{ inviteError }}</span>
            <button type="button" class="btn-close btn-sm ms-2" @click="inviteError = ''" aria-label="Close"></button>
          </div>
        </div>

        <div class="modal-footer border-0 p-4 pt-0">
          <button
            type="button"
            class="btn btn-link text-muted text-decoration-none fw-semibold me-auto"
            @click="closeInviteModal"
          >
            Cancel
          </button>
          <button
            type="button"
            class="btn btn-theme-primary rounded-pill px-5 py-2 fw-bold"
            :disabled="!inviteEmail.trim() || isInviting"
            @click="handleInviteUser"
          >
            <span v-if="isInviting" class="spinner-border spinner-border-sm me-2"></span>
            {{ isInviting ? 'Sending...' : 'Send invitation' }}
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- ── Add team modal ── -->
  <div v-if="showOrgModal" class="modal-overlay" @click.self="closeOrgModal">
    <div class="modal-dialog modal-dialog-centered">
      <div class="modal-content card shadow-lg border-0 glass-modal fade-in-up">
        <div class="modal-header border-0 p-4 pb-0">
          <h4 class="modal-title fw-bold">Add a team</h4>
          <button type="button" class="btn-close shadow-none" @click="closeOrgModal"></button>
        </div>

        <div class="modal-body p-4">
          <p class="text-muted small mb-3">
            All members of the selected organization will get
            <strong>Member</strong> access. You can change the role afterwards.
          </p>

          <div class="mb-3">
            <label class="form-label fw-semibold small">Organization</label>
            <div v-if="isLoadingOrgList" class="text-center py-2">
              <div class="spinner-border spinner-border-sm text-primary" role="status"></div>
            </div>
            <select
              v-else
              v-model="selectedOrgId"
              class="form-select theme-input"
            >
              <option value="" disabled>Select an organization…</option>
              <option
                v-for="org in organizations"
                :key="org.id"
                :value="org.id"
                :disabled="orgAccesses.some((a) => a.organization_id === org.id)"
              >
                {{ org.name }}
                <template v-if="orgAccesses.some((a) => a.organization_id === org.id)">
                  (already has access)
                </template>
              </option>
            </select>
          </div>

          <div v-if="addOrgError" class="text-danger small d-flex align-items-center">
            <i class="bi bi-exclamation-circle me-1"></i> {{ addOrgError }}
          </div>
        </div>

        <div class="modal-footer border-0 p-4 pt-0">
          <button
            type="button"
            class="btn btn-link text-muted text-decoration-none fw-semibold me-auto"
            @click="closeOrgModal"
          >
            Cancel
          </button>
          <button
            type="button"
            class="btn btn-theme-primary rounded-pill px-5 py-2 fw-bold"
            :disabled="!selectedOrgId || isAddingOrg"
            @click="handleAddOrg"
          >
            <span v-if="isAddingOrg" class="spinner-border spinner-border-sm me-2"></span>
            {{ isAddingOrg ? 'Granting...' : 'Grant access' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.back-link {
  transition: all 0.2s ease;
  opacity: 0.8;
  color: #64748b !important;
}

.back-link:hover {
  opacity: 1;
  color: var(--theme-primary) !important;
  transform: translateX(-4px);
}

.machine-hero-icon {
  font-size: 1.5rem;
  line-height: 1;
}

.collaborator-row {
  transition: background 0.15s ease;
}

.collaborator-row:hover {
  background: #f8fafc;
}

.org-row {
  cursor: pointer;
}

.avatar-circle {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 0.9rem;
  flex-shrink: 0;
}

.avatar-owner {
  background: #1e293b;
  color: #fff;
}

.avatar-member {
  background: #e2e8f0;
  color: #475569;
}

.avatar-org {
  background: #eff6ff;
  font-size: 1rem;
}

.role-select {
  width: auto;
  min-width: 110px;
  font-size: 0.85rem;
  border-radius: 8px;
  border-color: #e2e8f0;
  cursor: pointer;
}

.role-select:focus {
  border-color: var(--theme-primary, #0d6efd);
  box-shadow: 0 0 0 2px rgba(13, 110, 253, 0.15);
}

.role-option .border {
  border-color: #e2e8f0 !important;
  transition: border-color 0.15s ease, background 0.15s ease;
  cursor: pointer;
}

.role-option.selected .border {
  border-color: var(--theme-primary, #0d6efd) !important;
  background: #eff6ff;
}

.role-option.selected .text-muted {
  color: var(--theme-primary, #0d6efd) !important;
}

.min-w-0 {
  min-width: 0;
}

.cursor-pointer {
  cursor: pointer;
}

.border-dashed {
  border: 2px dashed #e2e8f0 !important;
  border-radius: 12px;
}
</style>
