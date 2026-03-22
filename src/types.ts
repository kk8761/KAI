export interface User {
  uid: string;
  displayName: string;
  email: string;
  photoURL?: string;
  status?: 'online' | 'offline';
  lastSeen?: any;
  publicKey?: string; // JWK format public key
}

export interface Message {
  id: string;
  chatId: string;
  senderId: string;
  text?: string;
  encryptedData?: string; // Base64 encoded encrypted message
  iv?: string; // Initialization vector
  mediaUrl?: string;
  mediaType?: 'image' | 'video' | 'audio' | 'pdf' | 'document' | 'archive' | 'other';
  fileName?: string;
  fileSize?: number;
  status: 'sent' | 'delivered' | 'read';
  createdAt: any;
  reactions?: Record<string, string[]>; // emoji -> [userIds]
  translation?: {
    text: string;
    language: string;
  };
  isPinned?: boolean;
}

export interface Chat {
  id: string;
  type: 'one-to-one' | 'group';
  participants: string[];
  admins?: string[]; // UIDs of group admins
  photoURL?: string; // Group icon
  lastMessage?: {
    text?: string;
    senderId: string;
    createdAt: any;
    status?: 'sent' | 'delivered' | 'read';
  };
  updatedAt: any;
  name?: string;
  groupKey?: Record<string, string>; // userId -> encrypted symmetric key
}
