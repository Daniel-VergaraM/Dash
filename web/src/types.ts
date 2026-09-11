export type Capability =
  | 'tasks:read' | 'tasks:write' | 'calendar:read' | 'notes:read' | 'notes:write'
  | 'drive:read' | 'music:read' | 'music:control' | 'github:read'
  | 'projects:read' | 'projects:write'
  | 'connections:manage' | 'users:manage';

export type Role = 'admin' | 'member' | 'guest';

export interface Me {
  auth: boolean;
  user: { id: string; name: string; role: Role };
  caps: Capability[];
  via?: string;
  connected: Record<'google' | 'spotify' | 'github' | 'linear', boolean>;
  configured: Record<'google' | 'spotify' | 'linear', boolean>;
}

export interface ApiError extends Error {
  status?: number;
}

export type Priority = 'low' | 'med' | 'high';

export interface CalEvent {
  id: string;
  title: string;
  notes: string;
  start: string;
  end: string;
  allDay: boolean;
  link: string;
  location: string;
  task: boolean;
  done: boolean;
  priority: Priority | null;
  project: string | null;
}

export interface LinearTeam { id: string; name: string; }

export type LinearStatusType = 'backlog' | 'planned' | 'started' | 'paused' | 'completed' | 'canceled';
export interface LinearProjectStatus { id: string; name: string; type: LinearStatusType; color: string; }

export interface Project {
  id: string;
  name: string;
  description: string;
  color: string;
  icon: string | null;
  url: string;
  progress: number;
  targetDate: string | null;
  startDate: string | null;
  createdAt: string;
  archivedAt: string | null;
  status: LinearProjectStatus;
  lead: { name: string } | null;
  stats?: { total: number; done: number };
}

export interface Subtask {
  id: string;
  title: string;
  done: boolean;
}

export interface NoteMeta {
  name: string;
  modified: number;
}

export interface NoteBody {
  name: string;
  body: string;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  webViewLink?: string;
  iconLink?: string;
  folder: boolean;
}

export interface SpotifyTrack {
  uri: string;
  name: string;
  artists: string;
  album: string;
  image: string;
  ms: number;
}

export interface SpotifyPlaylist {
  id: string;
  uri: string;
  name: string;
  owner: string;
  mine: boolean | null;
  collaborative: boolean;
  tracks: number;
  image: string;
}

export interface Passkey {
  id: string;
  label: string;
  createdAt: number;
  lastUsed: number | null;
}

export interface AccessUser {
  id: string;
  name: string;
  role: Role;
  permissions: Capability[] | null;
  caps: Capability[];
  macs: string[];
  disabled: boolean;
  hasPassword: boolean;
  passkeys: Passkey[];
  createdAt: number;
  lastSeen: number | null;
  sessions: { sid: string; via: string; ip: string; createdAt: number }[];
}

export interface AuditEntry {
  at: number;
  event: string;
  name?: string;
  by?: string;
  provider?: string;
  via?: string;
  ip?: string;
}

export interface AccessData {
  capabilities: Record<Capability, string>;
  roles: Record<Role, Capability[]>;
  users: AccessUser[];
  audit: AuditEntry[];
}

export type ViewName =
  | 'today' | 'tasks' | 'calendar' | 'notes' | 'drive' | 'music' | 'github' | 'account' | 'access';
