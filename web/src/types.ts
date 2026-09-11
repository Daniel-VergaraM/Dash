export type Capability =
  | 'tasks:read' | 'tasks:write' | 'calendar:read' | 'notes:read' | 'notes:write'
  | 'drive:read' | 'music:read' | 'music:control' | 'github:read'
  | 'connections:manage' | 'users:manage';

export type Role = 'admin' | 'member' | 'guest';

export interface Me {
  auth: boolean;
  user: { id: string; name: string; role: Role };
  caps: Capability[];
  via?: string;
  connected: Record<'google' | 'spotify' | 'github', boolean>;
  configured: Record<'google' | 'spotify', boolean>;
}

export interface ApiError extends Error {
  status?: number;
}

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
  | 'today' | 'calendar' | 'notes' | 'drive' | 'music' | 'github' | 'account' | 'access';
