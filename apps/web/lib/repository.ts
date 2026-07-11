// ─── Injectable Waitlist Repository Contract ────────────────────

export interface WaitlistEntry {
  email: string;
  signedUpAt: string;
}

export interface WaitlistRepository {
  add(email: string): Promise<{ success: boolean; error?: string }>;
  list(): Promise<WaitlistEntry[]>;
}

// ─── Default In-Memory Implementation ───────────────────────────

export class InMemoryWaitlistRepository implements WaitlistRepository {
  private entries: WaitlistEntry[] = [];

  async add(email: string): Promise<{ success: boolean; error?: string }> {
    const normalized = email.toLowerCase().trim();
    if (this.entries.some((e) => e.email === normalized)) {
      return { success: false, error: 'This email is already on the waitlist.' };
    }
    this.entries.push({ email: normalized, signedUpAt: new Date().toISOString() });
    return { success: true };
  }

  async list(): Promise<WaitlistEntry[]> {
    return [...this.entries];
  }
}

// ─── Registry (injectable via setWaitlistRepository) ────────────

let currentRepository: WaitlistRepository = new InMemoryWaitlistRepository();

export function setWaitlistRepository(repo: WaitlistRepository): void {
  currentRepository = repo;
}

export function getWaitlistRepository(): WaitlistRepository {
  return currentRepository;
}
