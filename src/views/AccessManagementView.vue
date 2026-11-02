<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { useAuthStore } from '../stores/auth'
import { useMachinesStore } from '../stores/machines'
import { authService } from '../services/authService'
import type { DesktopInvite } from '../types'
import MachineAccessView from './MachineAccessView.vue'

const authStore = useAuthStore()
const machinesStore = useMachinesStore()

// Only ever rendered inside AccountPanel's popup — drills into a machine's
// detail page in place instead of navigating to a
// separate route (which would just close the popup).
const selectedMachineId = ref<string | null>(null)
function openMachineAccess(id: string) {
  selectedMachineId.value = id
}

// --- Desktop Invitations ---
const invitations = ref<DesktopInvite[]>([])
const isLoadingInvitations = ref(false)
const respondingId = ref<string | null>(null)
const respondError = ref('')

// Each area gets its own tab rather than stacking every list in one scroll.
type AccessTab = 'machines' | 'invitations'
const tabs: { id: AccessTab; label: string; icon: string }[] = [
  { id: 'machines', label: 'Machines', icon: 'bi-pc-display' },
  { id: 'invitations', label: 'Invitations', icon: 'bi-envelope' },
]
const activeTab = ref<AccessTab>('machines')

// --- Computed ---
const pendingInviteCount = computed(() => invitations.value.length)
const accessibleMachines = computed(() =>
  machinesStore.desktops.filter((d) => d.role === 'owner' || d.role === 'admin'),
)

// --- Fetch ---
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

watch(
  () => authStore.session,
  (session) => {
    if (session) {
      fetchInvitations()
    }
  },
  { immediate: true },
)

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

        <template v-if="!selectedMachineId">

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

        <!-- ── Invitations ── -->
        <div v-else>
          <p class="text-muted small mb-3">Invitations other people have sent you to join their machines.</p>

          <div v-if="respondError" class="alert alert-danger d-flex align-items-center mb-3 py-2" role="alert">
            <i class="bi bi-exclamation-triangle-fill me-2"></i>{{ respondError }}
          </div>

          <div v-if="isLoadingInvitations" class="text-center py-3">
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
            </div>
          </div>
        </div>

        </template>

        <MachineAccessView
          v-else-if="selectedMachineId"
          :key="selectedMachineId"
          :machine-id="selectedMachineId"
          @back="selectedMachineId = null"
        />

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

.access-row {
  cursor: pointer;
  transition: background 0.15s ease;
}

.access-row:hover {
  background: #f8fafc;
}

.min-w-0 {
  min-width: 0;
}
</style>
