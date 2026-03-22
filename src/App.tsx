import * as React from 'react';
import { useState, useEffect, useRef } from 'react';
import { auth, db, googleProvider, OperationType, handleFirestoreError, storage } from './firebase';
import { signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';
import { doc, setDoc, getDoc, serverTimestamp, onSnapshot, collection, query, where, orderBy, limit, addDoc, deleteDoc, writeBatch } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { io, Socket } from 'socket.io-client';
import { User, Chat, Message } from './types';
import { EncryptionService } from './services/encryptionService';
import { LogOut, Search, MoreVertical, Send, Paperclip, Smile, Check, CheckCheck, User as UserIcon, Users, MessageSquare, Plus, Sparkles, Mic, Square, Trash2, FileText, FileArchive, File, Download, Pin, X, Shield, UserMinus, UserPlus, Camera, Settings, Video, VideoOff, Phone, PhoneOff, PhoneIncoming, Volume2, VolumeX, Clock, Calendar } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { format } from 'date-fns';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { GoogleGenAI } from "@google/genai";
import { Timestamp } from 'firebase/firestore';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

const LANGUAGES = [
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'it', name: 'Italian' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'zh', name: 'Chinese' },
  { code: 'hi', name: 'Hindi' },
  { code: 'ar', name: 'Arabic' },
];

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const HighlightText = ({ text, highlight }: { text: string, highlight: string }) => {
  if (!highlight.trim()) {
    return <>{text}</>;
  }
  const regex = new RegExp(`(${highlight.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  const parts = text.split(regex);
  return (
    <>
      {parts.map((part, i) => 
        part.toLowerCase() === highlight.toLowerCase() ? (
          <mark key={i} className="bg-yellow-400/40 text-white rounded-sm px-0.5 ring-1 ring-yellow-400/20">{part}</mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

const DecryptedMedia = ({ 
  msg, 
  chatKey, 
  onOpen 
}: { 
  msg: Message, 
  chatKey: CryptoKey | null, 
  onOpen: (url: string) => void 
}) => {
  const [decryptedUrl, setDecryptedUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const decrypt = async () => {
      if (msg.mediaUrl && msg.encryptedData && msg.iv && chatKey) {
        setLoading(true);
        try {
          const response = await fetch(msg.mediaUrl);
          const encryptedBuffer = await response.arrayBuffer();
          const decryptedBuffer = await EncryptionService.decryptBuffer(encryptedBuffer, msg.iv, chatKey);
          const blob = new Blob([decryptedBuffer], { type: msg.mediaType === 'image' ? 'image/jpeg' : msg.mediaType === 'video' ? 'video/mp4' : 'application/octet-stream' });
          const url = URL.createObjectURL(blob);
          setDecryptedUrl(url);
        } catch (e) {
          console.error('Failed to decrypt media', e);
        } finally {
          setLoading(false);
        }
      } else if (msg.mediaUrl && !msg.encryptedData) {
        // Legacy unencrypted media
        setDecryptedUrl(msg.mediaUrl);
      }
    };
    decrypt();
    return () => {
      if (decryptedUrl && decryptedUrl.startsWith('blob:')) {
        URL.revokeObjectURL(decryptedUrl);
      }
    };
  }, [msg.mediaUrl, msg.encryptedData, msg.iv, chatKey]);

  if (loading) {
    return (
      <div className="w-full h-40 bg-black/20 animate-pulse flex items-center justify-center rounded-xl">
        <Sparkles className="text-primary animate-spin" size={24} />
      </div>
    );
  }

  if (!decryptedUrl) return null;

  if (msg.mediaType === 'image') {
    return (
      <img 
        src={decryptedUrl} 
        alt="Shared media" 
        className="max-w-full max-h-[300px] object-contain cursor-pointer hover:scale-[1.02] transition-transform"
        referrerPolicy="no-referrer"
        onClick={() => onOpen(decryptedUrl)}
      />
    );
  }

  if (msg.mediaType === 'video') {
    return (
      <video 
        src={decryptedUrl} 
        controls 
        className="max-w-full max-h-[300px]"
      />
    );
  }

  if (msg.mediaType === 'audio') {
    return (
      <audio 
        src={decryptedUrl} 
        controls 
        className="max-w-full h-10 filter invert brightness-200"
      />
    );
  }

  return (
    <div 
      className="p-4 flex items-center gap-3 cursor-pointer hover:bg-white/5 transition-colors"
      onClick={() => onOpen(decryptedUrl)}
    >
      <div className="w-12 h-12 rounded-xl bg-white/10 flex items-center justify-center flex-shrink-0">
        {msg.mediaType === 'pdf' ? (
          <FileText className="text-red-400" />
        ) : msg.mediaType === 'document' ? (
          <FileText className="text-blue-400" />
        ) : msg.mediaType === 'archive' ? (
          <FileArchive className="text-amber-400" />
        ) : (
          <File className="text-slate-400" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold truncate text-white">{msg.fileName || 'Unnamed file'}</p>
        <p className="text-[10px] text-white/50 font-medium uppercase">
          {msg.fileSize ? `${(msg.fileSize / 1024).toFixed(1)} KB` : 'File'} • {msg.mediaType}
        </p>
      </div>
      <Download size={18} className="text-white/40" />
    </div>
  );
};

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChat, setActiveChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [decryptedMessages, setDecryptedMessages] = useState<Record<string, string>>({});
  const [decryptedLastMessages, setDecryptedLastMessages] = useState<Record<string, string>>({});

  useEffect(() => {
    const decryptLastMessages = async () => {
      if (!user) return;
      const privateKey = EncryptionService.getStoredPrivateKey();
      if (!privateKey) return;

      const newDecrypted: Record<string, string> = {};
      for (const chat of chats) {
        if (chat.lastMessage && chat.lastMessage.encryptedData && chat.lastMessage.iv && chat.groupKey?.[user.uid]) {
          try {
            const chatKey = await EncryptionService.decryptSymmetricKey(chat.groupKey[user.uid], privateKey);
            const decrypted = await EncryptionService.decryptText(chat.lastMessage.encryptedData, chat.lastMessage.iv, chatKey);
            newDecrypted[chat.id] = decrypted;
          } catch (e) {
            console.error(`Failed to decrypt last message for chat ${chat.id}`, e);
            newDecrypted[chat.id] = 'Encrypted Message';
          }
        } else if (chat.lastMessage) {
          newDecrypted[chat.id] = chat.lastMessage.text || '';
        }
      }
      setDecryptedLastMessages(newDecrypted);
    };
    decryptLastMessages();
  }, [chats, user]);
  const [chatKey, setChatKey] = useState<CryptoKey | null>(null);
  const [typingUsers, setTypingUsers] = useState<Record<string, boolean>>({});
  const [searchTerm, setSearchTerm] = useState('');
  const [chatSearchTerm, setChatSearchTerm] = useState('');
  const [isChatSearchOpen, setIsChatSearchOpen] = useState(false);
  const [sidebarView, setSidebarView] = useState<'chats' | 'contacts'>('chats');
  const [newMessage, setNewMessage] = useState('');
  const [showNewChatModal, setShowNewChatModal] = useState(false);
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [selectedUsers, setSelectedUsers] = useState<User[]>([]);
  const [groupName, setGroupName] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [isRephrasing, setIsRephrasing] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [translatingMessageId, setTranslatingMessageId] = useState<string | null>(null);
  const [showTranslateMenu, setShowTranslateMenu] = useState<string | null>(null);
  const [showPinnedMessages, setShowPinnedMessages] = useState(false);
  const [showGroupSettings, setShowGroupSettings] = useState(false);
  const [isAddingMember, setIsAddingMember] = useState(false);
  const [scheduledTime, setScheduledTime] = useState<string>('');
  const [showScheduler, setShowScheduler] = useState(false);
  const [callStatus, setCallStatus] = useState<'idle' | 'calling' | 'incoming' | 'active'>('idle');
  const [incomingCall, setIncomingCall] = useState<{ from: string, name: string, photoURL: string, offer: any, isGroup: boolean } | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [isAudioMuted, setIsAudioMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const groupIconInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isCancelledRef = useRef(false);

  useEffect(() => {
    if (user && (showNewChatModal || sidebarView === 'contacts')) {
      const q = query(collection(db, 'users'), limit(50));
      const unsubscribe = onSnapshot(q, (snapshot) => {
        const users = snapshot.docs
          .map(doc => doc.data() as User)
          .filter(u => u.uid !== user.uid);
        setAllUsers(users);
      });
      return () => unsubscribe();
    }
  }, [user, showNewChatModal, sidebarView]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        const userDoc = await getDoc(doc(db, 'users', firebaseUser.uid));
        const userData: User = {
          uid: firebaseUser.uid,
          displayName: firebaseUser.displayName || 'Anonymous',
          email: firebaseUser.email || '',
          photoURL: firebaseUser.photoURL || undefined,
          status: 'online',
          lastSeen: serverTimestamp(),
          publicKey: userDoc.exists() ? (userDoc.data() as User).publicKey : undefined,
        };

        if (!userDoc.exists()) {
          await setDoc(doc(db, 'users', firebaseUser.uid), userData);
        } else {
          await setDoc(doc(db, 'users', firebaseUser.uid), { status: 'online', lastSeen: serverTimestamp() }, { merge: true });
        }
        setUser(userData);
      } else {
        setUser(null);
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  // Key Management
  useEffect(() => {
    const initEncryption = async () => {
      if (user) {
        let publicKey = EncryptionService.getStoredPublicKey();
        if (!publicKey) {
          const keys = await EncryptionService.generateUserKeyPair();
          publicKey = keys.publicKey;
        }
        
        // Ensure Firestore has the public key
        const userDoc = await getDoc(doc(db, 'users', user.uid));
        if (userDoc.exists()) {
          const userData = userDoc.data() as User;
          if (userData.publicKey !== publicKey) {
            await setDoc(doc(db, 'users', user.uid), { publicKey }, { merge: true });
          }
        }
      }
    };
    initEncryption();
  }, [user]);

  // Decrypt Messages when they change or chat key changes
  useEffect(() => {
    const decryptAll = async () => {
      if (chatKey && messages.length > 0) {
        const newDecrypted: Record<string, string> = { ...decryptedMessages };
        let changed = false;

        for (const msg of messages) {
          if (msg.encryptedData && msg.iv && !newDecrypted[msg.id]) {
            try {
              const decrypted = await EncryptionService.decryptText(msg.encryptedData, msg.iv, chatKey);
              newDecrypted[msg.id] = decrypted;
              changed = true;
            } catch (e) {
              console.error('Failed to decrypt message', msg.id, e);
              newDecrypted[msg.id] = '[Decryption Failed]';
              changed = true;
            }
          }
        }

        if (changed) {
          setDecryptedMessages(newDecrypted);
        }
      }
    };
    decryptAll();
  }, [messages, chatKey]);

  // Load Chat Key
  useEffect(() => {
    const loadKey = async () => {
      if (activeChat && user) {
        const privateKey = EncryptionService.getStoredPrivateKey();
        if (privateKey && activeChat.groupKey && activeChat.groupKey[user.uid]) {
          try {
            const key = await EncryptionService.decryptSymmetricKey(activeChat.groupKey[user.uid], privateKey);
            setChatKey(key);
          } catch (e) {
            console.error('Failed to decrypt chat key', e);
            setChatKey(null);
          }
        } else {
          setChatKey(null);
        }
      } else {
        setChatKey(null);
      }
    };
    loadKey();
  }, [activeChat, user]);
  useEffect(() => {
    if (user) {
      socketRef.current = io();
      
      socketRef.current.on('incoming-call', (data) => {
        setIncomingCall(data);
        setCallStatus('incoming');
      });

      socketRef.current.on('call-answered', async (data) => {
        if (peerConnectionRef.current) {
          await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(data.answer));
          setCallStatus('active');
        }
      });

      socketRef.current.on('ice-candidate', async (data) => {
        if (peerConnectionRef.current) {
          try {
            await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(data.candidate));
          } catch (e) {
            console.error('Error adding ice candidate', e);
          }
        }
      });

      socketRef.current.on('call-ended', () => {
        endCall();
      });

      const q = query(
        collection(db, 'chats'),
        where('participants', 'array-contains', user.uid),
        orderBy('updatedAt', 'desc')
      );

      const unsubscribe = onSnapshot(q, (snapshot) => {
        const chatList = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Chat));
        setChats(chatList);
      }, (error) => {
        handleFirestoreError(error, OperationType.LIST, 'chats');
      });

      return () => {
        unsubscribe();
        socketRef.current?.disconnect();
      };
    }
  }, [user]);

  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (user) {
        const status = document.visibilityState === 'visible' ? 'online' : 'offline';
        await setDoc(doc(db, 'users', user.uid), { status, lastSeen: serverTimestamp() }, { merge: true });
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [user]);

  useEffect(() => {
    if (activeChat && user) {
      setIsChatSearchOpen(false);
      setChatSearchTerm('');
      socketRef.current?.emit('join-room', activeChat.id);

      const q = query(
        collection(db, 'chats', activeChat.id, 'messages'),
        orderBy('createdAt', 'asc'),
        limit(100)
      );

      const unsubscribe = onSnapshot(q, (snapshot) => {
        const messageList = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Message));
        setMessages(messageList);
        
        // Mark messages as read if tab is visible
        if (document.visibilityState === 'visible') {
          const batch = writeBatch(db);
          let hasUpdates = false;
          let lastMessageMarkedAsRead = false;
          
          snapshot.docs.forEach((msgDoc) => {
            const msgData = msgDoc.data() as Message;
            if (msgData.senderId !== user.uid && msgData.status !== 'read') {
              batch.update(doc(db, 'chats', activeChat.id, 'messages', msgDoc.id), { status: 'read' });
              hasUpdates = true;

              if (activeChat.lastMessage?.createdAt?.toMillis() === msgData.createdAt?.toMillis()) {
                lastMessageMarkedAsRead = true;
              }
            }
          });
          
          if (hasUpdates) {
            if (lastMessageMarkedAsRead) {
              batch.update(doc(db, 'chats', activeChat.id), {
                'lastMessage.status': 'read'
              });
            }
            batch.commit().catch(err => {
              handleFirestoreError(err, OperationType.UPDATE, `chats/${activeChat.id}/messages`);
            });
          }
        }
      }, (error) => {
        handleFirestoreError(error, OperationType.LIST, `chats/${activeChat.id}/messages`);
      });

      return () => unsubscribe();
    }
  }, [activeChat, user]);

  useEffect(() => {
    const markAsRead = async () => {
      if (document.visibilityState === 'visible' && activeChat && user && messages.length > 0) {
        const batch = writeBatch(db);
        let hasUpdates = false;
        let lastMessageMarkedAsRead = false;
        
        messages.forEach((msg) => {
          if (msg.senderId !== user.uid && msg.status !== 'read') {
            batch.update(doc(db, 'chats', activeChat.id, 'messages', msg.id), { status: 'read' });
            hasUpdates = true;
            
            // Check if this is the last message in the chat
            if (activeChat.lastMessage?.createdAt?.toMillis() === msg.createdAt?.toMillis()) {
              lastMessageMarkedAsRead = true;
            }
          }
        });
        
        if (hasUpdates) {
          if (lastMessageMarkedAsRead) {
            batch.update(doc(db, 'chats', activeChat.id), {
              'lastMessage.status': 'read'
            });
          }
          
          try {
            await batch.commit();
          } catch (err) {
            handleFirestoreError(err, OperationType.UPDATE, `chats/${activeChat.id}/messages`);
          }
        }
      }
    };

    document.addEventListener('visibilitychange', markAsRead);
    // Also run it immediately when messages or activeChat change
    markAsRead();

    return () => document.removeEventListener('visibilitychange', markAsRead);
  }, [activeChat, user, messages]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket) return;

    socket.on('receive-message', (data) => {
      // Handled by Firestore onSnapshot
    });

    socket.on('user-typing', (data) => {
      if (data.chatId === activeChat?.id) {
        setTypingUsers(prev => ({ ...prev, [data.userId]: data.isTyping }));
      }
    });

    return () => {
      socket.off('receive-message');
      socket.off('user-typing');
    };
  }, [activeChat]);

  const handleLogin = async () => {
    if (isLoggingIn) return;
    setIsLoggingIn(true);
    setLoginError(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error: any) {
      console.error('Login failed:', error);
      if (error.code === 'auth/cancelled-popup-request') {
        setLoginError('A login request is already in progress. Please check your open windows.');
      } else if (error.code === 'auth/popup-blocked') {
        setLoginError('Popup blocked. Please allow popups for this site or open the app in a new tab.');
      } else {
        setLoginError(error.message || 'Login failed. Please try again.');
      }
    } finally {
      setIsLoggingIn(false);
    }
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];
      isCancelledRef.current = false;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      recorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        if (audioBlob.size > 0 && !isCancelledRef.current) {
          await uploadVoiceMessage(audioBlob);
        }
        stream.getTracks().forEach(track => track.stop());
      };

      recorder.start();
      setIsRecording(true);
      setRecordingTime(0);
      recordingIntervalRef.current = setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);
    } catch (err) {
      console.error('Error accessing microphone:', err);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      if (recordingIntervalRef.current) clearInterval(recordingIntervalRef.current);
    }
  };

  const cancelRecording = () => {
    isCancelledRef.current = true;
    stopRecording();
  };

  const uploadVoiceMessage = async (blob: Blob) => {
    if (!activeChat || !user) return;
    setIsUploading(true);
    try {
      let uploadData: Blob = blob;
      let encryptedInfo: { encryptedData?: string, iv?: string } = {};

      if (chatKey) {
        const buffer = await blob.arrayBuffer();
        const { encryptedData, iv } = await EncryptionService.encryptData(buffer, chatKey);
        uploadData = new Blob([new Uint8Array(atob(encryptedData).split("").map(c => c.charCodeAt(0)))]);
        encryptedInfo = { encryptedData, iv };
      }

      const fileName = `voice_${Date.now()}.webm`;
      const storageRef = ref(storage, `chats/${activeChat.id}/voice/${fileName}`);
      await uploadBytes(storageRef, uploadData);
      const url = await getDownloadURL(storageRef);

      const msgData: Partial<Message> = {
        chatId: activeChat.id,
        senderId: user.uid,
        mediaUrl: url,
        mediaType: 'audio',
        status: 'sent',
        createdAt: serverTimestamp(),
        ...encryptedInfo
      };

      const msgRef = await addDoc(collection(db, 'chats', activeChat.id, 'messages'), msgData);
      await setDoc(doc(db, 'chats', activeChat.id), {
        lastMessage: {
          text: '🎤 Voice message',
          senderId: user.uid,
          createdAt: serverTimestamp(),
          status: 'sent',
        },
        updatedAt: serverTimestamp(),
      }, { merge: true });

      socketRef.current?.emit('send-message', { ...msgData, id: msgRef.id, roomId: activeChat.id });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'messages');
    } finally {
      setIsUploading(false);
    }
  };

  const handleLogout = async () => {
    if (user) {
      await setDoc(doc(db, 'users', user.uid), { status: 'offline', lastSeen: serverTimestamp() }, { merge: true });
      await signOut(auth);
    }
  };

  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim() || !activeChat || !user) return;

    let messageData: Partial<Message> = {
      chatId: activeChat.id,
      senderId: user.uid,
      status: 'sent',
      createdAt: serverTimestamp(),
    };

    // Encrypt if chat key is available
    if (chatKey) {
      try {
        const { encryptedData, iv } = await EncryptionService.encryptData(newMessage, chatKey);
        messageData.encryptedData = encryptedData;
        messageData.iv = iv;
        messageData.text = null; // Don't store plain text
      } catch (e) {
        console.error('Encryption failed, sending as plain text', e);
        messageData.text = newMessage;
      }
    } else {
      messageData.text = newMessage;
    }

    try {
      const msgRef = await addDoc(collection(db, 'chats', activeChat.id, 'messages'), messageData);
      
      // Update chat's last message
      const lastMessageData: any = {
        senderId: user.uid,
        createdAt: serverTimestamp(),
        status: 'sent',
      };

      if (chatKey && messageData.encryptedData) {
        lastMessageData.text = '🔒 Encrypted message';
        lastMessageData.encryptedData = messageData.encryptedData;
        lastMessageData.iv = messageData.iv;
      } else {
        lastMessageData.text = newMessage;
      }

      await setDoc(doc(db, 'chats', activeChat.id), {
        lastMessage: lastMessageData,
        updatedAt: serverTimestamp(),
      }, { merge: true });

      socketRef.current?.emit('send-message', { ...messageData, id: msgRef.id, roomId: activeChat.id });
      setNewMessage('');
      socketRef.current?.emit('typing', { chatId: activeChat.id, userId: user.uid, isTyping: false });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `chats/${activeChat.id}/messages`);
    }
  };

  const handleTyping = (e: React.ChangeEvent<HTMLInputElement>) => {
    setNewMessage(e.target.value);
    if (activeChat && user) {
      socketRef.current?.emit('typing', {
        chatId: activeChat.id,
        userId: user.uid,
        isTyping: e.target.value.length > 0
      });
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !activeChat || !user) return;

    const isImage = file.type.startsWith('image/');
    const isVideo = file.type.startsWith('video/');
    const isAudio = file.type.startsWith('audio/');
    const isPdf = file.type === 'application/pdf';
    const isDoc = file.type.includes('word') || file.type.includes('text') || file.type.includes('document');
    const isArchive = file.type.includes('zip') || file.type.includes('rar') || file.type.includes('tar');

    let mediaType: Message['mediaType'] = 'other';
    if (isImage) mediaType = 'image';
    else if (isVideo) mediaType = 'video';
    else if (isAudio) mediaType = 'audio';
    else if (isPdf) mediaType = 'pdf';
    else if (isDoc) mediaType = 'document';
    else if (isArchive) mediaType = 'archive';

    setIsUploading(true);
    try {
      let uploadData: Blob | ArrayBuffer = file;
      let encryptedInfo: { encryptedData?: string, iv?: string } = {};

      if (chatKey) {
        const fileBuffer = await file.arrayBuffer();
        const { encryptedData, iv } = await EncryptionService.encryptData(fileBuffer, chatKey);
        uploadData = new Blob([new Uint8Array(atob(encryptedData).split("").map(c => c.charCodeAt(0)))]);
        encryptedInfo = { encryptedData, iv };
      }

      const storageRef = ref(storage, `chats/${activeChat.id}/${Date.now()}_${file.name}`);
      await uploadBytes(storageRef, uploadData);
      const downloadURL = await getDownloadURL(storageRef);

      const messageData: Partial<Message> = {
        chatId: activeChat.id,
        senderId: user.uid,
        text: '',
        mediaUrl: downloadURL,
        mediaType,
        fileName: file.name,
        fileSize: file.size,
        status: 'sent',
        createdAt: serverTimestamp(),
        ...encryptedInfo
      };

      const msgRef = await addDoc(collection(db, 'chats', activeChat.id, 'messages'), messageData);
      
      let lastMessageText = '📁 File';
      if (isImage) lastMessageText = '📷 Image';
      else if (isVideo) lastMessageText = '🎥 Video';
      else if (isAudio) lastMessageText = '🎤 Audio';
      else if (isPdf) lastMessageText = '📄 PDF';

      await setDoc(doc(db, 'chats', activeChat.id), {
        lastMessage: {
          text: lastMessageText,
          senderId: user.uid,
          createdAt: serverTimestamp(),
          status: 'sent',
        },
        updatedAt: serverTimestamp(),
      }, { merge: true });

      socketRef.current?.emit('send-message', { ...messageData, id: msgRef.id, roomId: activeChat.id });
    } catch (error) {
      console.error('Upload failed:', error);
      alert('Failed to upload file. Please try again.');
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const rephraseText = async () => {
    if (!newMessage.trim() || isRephrasing) return;
    setIsRephrasing(true);
    try {
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `Rephrase this message to be more professional and clear, but keep it concise: "${newMessage}"`,
      });
      if (response.text) {
        setNewMessage(response.text.trim());
      }
    } catch (error) {
      console.error('Rephrase failed:', error);
    } finally {
      setIsRephrasing(false);
    }
  };

  const toggleReaction = async (message: Message, emoji: string) => {
    if (!user || !activeChat) return;
    const reactions = message.reactions || {};
    const userIds = reactions[emoji] || [];
    const newUserIds = userIds.includes(user.uid)
      ? userIds.filter(id => id !== user.uid)
      : [...userIds, user.uid];

    const updatedReactions = { ...reactions };
    if (newUserIds.length > 0) {
      updatedReactions[emoji] = newUserIds;
    } else {
      delete updatedReactions[emoji];
    }

    try {
      await setDoc(doc(db, 'chats', activeChat.id, 'messages', message.id), {
        reactions: updatedReactions
      }, { merge: true });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `chats/${activeChat.id}/messages/${message.id}`);
    }
  };

  const deleteMessage = async (message: Message) => {
    if (!user || !activeChat || message.senderId !== user.uid) return;
    
    try {
      await deleteDoc(doc(db, 'chats', activeChat.id, 'messages', message.id));
      
      // If this was the last message, update the chat's lastMessage
      if (activeChat.lastMessage?.createdAt?.toMillis() === message.createdAt?.toMillis()) {
        const q = query(
          collection(db, 'chats', activeChat.id, 'messages'),
          orderBy('createdAt', 'desc'),
          limit(1)
        );
        const snapshot = await getDoc(doc(db, 'chats', activeChat.id)); // Just to be safe, though we usually have it in state
        // Actually, we can just get the next message from the messages array if it's already in state
        // But it's safer to query Firestore or just set it to a placeholder if it was the only message
        
        // For simplicity, we'll just update with a "Message deleted" placeholder if it was the last one
        // or leave it as is if there are other messages (Firestore listener will eventually update if we do a more complex logic)
        // Better: just clear it or set to previous if we had it.
        // Let's just set it to a generic "Message deleted" for the last message preview if it was the one deleted.
        await setDoc(doc(db, 'chats', activeChat.id), {
          lastMessage: {
            text: '🚫 Message deleted',
            senderId: user.uid,
            createdAt: serverTimestamp(),
          },
          updatedAt: serverTimestamp(),
        }, { merge: true });
      }

      socketRef.current?.emit('delete-message', { messageId: message.id, roomId: activeChat.id });
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `chats/${activeChat.id}/messages/${message.id}`);
    }
  };

  const translateMessage = async (message: Message, targetLang: string) => {
    if (!message.text || !activeChat) return;
    setTranslatingMessageId(message.id);
    setShowTranslateMenu(null);
    try {
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `Translate the following message to ${targetLang}. Only return the translated text: "${message.text}"`,
      });
      if (response.text) {
        await setDoc(doc(db, 'chats', activeChat.id, 'messages', message.id), {
          translation: {
            text: response.text.trim(),
            language: targetLang
          }
        }, { merge: true });
      }
    } catch (error) {
      console.error('Translation failed:', error);
    } finally {
      setTranslatingMessageId(null);
    }
  };

  const togglePinMessage = async (message: Message) => {
    if (!activeChat) return;
    try {
      await setDoc(doc(db, 'chats', activeChat.id, 'messages', message.id), {
        isPinned: !message.isPinned
      }, { merge: true });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `chats/${activeChat.id}/messages/${message.id}`);
    }
  };

  const updateGroupSettings = async (updates: Partial<Chat>) => {
    if (!activeChat || activeChat.type !== 'group') return;
    try {
      await setDoc(doc(db, 'chats', activeChat.id), updates, { merge: true });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `chats/${activeChat.id}`);
    }
  };

  const addMemberToGroup = async (newUserId: string) => {
    if (!activeChat || activeChat.type !== 'group' || !chatKey) return;
    
    try {
      const newUserDoc = await getDoc(doc(db, 'users', newUserId));
      if (!newUserDoc.exists()) return;
      const newUserData = newUserDoc.data() as User;
      
      if (!newUserData.publicKey) {
        alert("This user hasn't set up encryption yet. They cannot be added to an encrypted group.");
        return;
      }

      const encryptedGroupKey = await EncryptionService.encryptSymmetricKey(chatKey, newUserData.publicKey);
      const newParticipants = [...activeChat.participants, newUserId];
      const newGroupKey = { ...activeChat.groupKey, [newUserId]: encryptedGroupKey };
      
      await updateGroupSettings({ 
        participants: newParticipants,
        groupKey: newGroupKey
      });
    } catch (error) {
      console.error('Error adding member to group:', error);
    }
  };

  const removeMemberFromGroup = async (memberId: string) => {
    if (!activeChat || activeChat.type !== 'group') return;
    const newParticipants = activeChat.participants.filter(id => id !== memberId);
    const newAdmins = (activeChat.admins || []).filter(id => id !== memberId);
    await updateGroupSettings({ participants: newParticipants, admins: newAdmins });
  };

  const promoteToAdmin = async (memberId: string) => {
    if (!activeChat || activeChat.type !== 'group') return;
    const newAdmins = [...(activeChat.admins || []), memberId];
    await updateGroupSettings({ admins: newAdmins });
  };

  const handleGroupIconUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !activeChat || activeChat.type !== 'group') return;

    setIsUploading(true);
    try {
      const storageRef = ref(storage, `group_icons/${activeChat.id}/${Date.now()}_${file.name}`);
      await uploadBytes(storageRef, file);
      const url = await getDownloadURL(storageRef);
      await updateGroupSettings({ photoURL: url });
    } catch (error) {
      console.error('Error uploading group icon:', error);
    } finally {
      setIsUploading(false);
    }
  };

  const setupPeerConnection = (stream: MediaStream) => {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    stream.getTracks().forEach(track => pc.addTrack(track, stream));

    pc.onicecandidate = (event) => {
      if (event.candidate && socketRef.current && activeChat) {
        socketRef.current.emit('ice-candidate', {
          to: activeChat.id,
          candidate: event.candidate
        });
      }
    };

    pc.ontrack = (event) => {
      setRemoteStream(event.streams[0]);
    };

    peerConnectionRef.current = pc;
    return pc;
  };

  const startCall = async () => {
    if (!activeChat || !user || !socketRef.current) return;
    
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setLocalStream(stream);
      setCallStatus('calling');

      const pc = setupPeerConnection(stream);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      socketRef.current.emit('call-user', {
        to: activeChat.id,
        offer,
        from: user.uid,
        name: user.displayName,
        photoURL: user.photoURL,
        isGroup: activeChat.type === 'group'
      });
    } catch (error) {
      console.error('Error starting call:', error);
    }
  };

  const answerCall = async () => {
    if (!incomingCall || !user || !socketRef.current) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setLocalStream(stream);
      setCallStatus('active');

      const pc = setupPeerConnection(stream);
      await pc.setRemoteDescription(new RTCSessionDescription(incomingCall.offer));
      
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socketRef.current.emit('answer-call', {
        to: incomingCall.from,
        answer
      });
      
      setIncomingCall(null);
    } catch (error) {
      console.error('Error answering call:', error);
    }
  };

  const endCall = () => {
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
    }
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    if (socketRef.current && activeChat) {
      socketRef.current.emit('end-call', { to: activeChat.id });
    }
    setLocalStream(null);
    setRemoteStream(null);
    setCallStatus('idle');
    setIncomingCall(null);
    setIsAudioMuted(false);
    setIsVideoOff(false);
  };

  const toggleAudio = () => {
    if (localStream) {
      const audioTrack = localStream.getAudioTracks()[0];
      audioTrack.enabled = !audioTrack.enabled;
      setIsAudioMuted(!audioTrack.enabled);
    }
  };

  const toggleVideo = () => {
    if (localStream) {
      const videoTrack = localStream.getVideoTracks()[0];
      videoTrack.enabled = !videoTrack.enabled;
      setIsVideoOff(!videoTrack.enabled);
    }
  };

  const scheduleMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim() || !activeChat || !user || !scheduledTime) return;

    const scheduledDate = new Date(scheduledTime);
    if (scheduledDate <= new Date()) {
      alert("Please choose a future time.");
      return;
    }

    const scheduledId = Date.now().toString();
    try {
      await setDoc(doc(db, 'scheduledMessages', scheduledId), {
        id: scheduledId,
        chatId: activeChat.id,
        senderId: user.uid,
        text: newMessage,
        scheduledAt: Timestamp.fromDate(scheduledDate),
        status: 'pending'
      });
      setNewMessage('');
      setScheduledTime('');
      setShowScheduler(false);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'scheduledMessages');
    }
  };

  const createGroupChat = async () => {
    if (!user || selectedUsers.length < 1 || !groupName.trim()) return;
    
    const participants = [user.uid, ...selectedUsers.map(u => u.uid)];
    
    // Check if all participants have public keys
    const missingKeys = selectedUsers.filter(u => !u.publicKey);
    if (missingKeys.length > 0) {
      alert(`The following users haven't set up encryption: ${missingKeys.map(u => u.displayName).join(', ')}`);
      return;
    }

    const chatId = `group_${Date.now()}`;
    
    // Generate Group Key
    const symmetricKey = await EncryptionService.generateSymmetricKey();
    const groupKey: Record<string, string> = {};
    
    // Encrypt for self
    const myPublicKey = EncryptionService.getStoredPublicKey();
    if (myPublicKey) {
      groupKey[user.uid] = await EncryptionService.encryptSymmetricKey(symmetricKey, myPublicKey);
    }
    
    // Encrypt for others
    for (const u of selectedUsers) {
      if (u.publicKey) {
        groupKey[u.uid] = await EncryptionService.encryptSymmetricKey(symmetricKey, u.publicKey);
      }
    }

    const chatData: Chat = {
      id: chatId,
      type: 'group',
      participants,
      admins: [user.uid],
      updatedAt: serverTimestamp(),
      name: groupName,
      groupKey,
    };

    try {
      await setDoc(doc(db, 'chats', chatId), chatData);
      setActiveChat(chatData);
      setShowNewChatModal(false);
      setSelectedUsers([]);
      setGroupName('');
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `chats/${chatId}`);
    }
  };

  const startChat = async (otherUser: User) => {
    if (!user) return;
    
    if (!otherUser.publicKey) {
      alert(`${otherUser.displayName} hasn't set up encryption yet.`);
      return;
    }

    // Check if chat already exists
    const existingChat = chats.find(c => 
      c.type === 'one-to-one' && c.participants.includes(otherUser.uid)
    );

    if (existingChat) {
      setActiveChat(existingChat);
      setShowNewChatModal(false);
      return;
    }

    const chatId = [user.uid, otherUser.uid].sort().join('_');
    
    // Generate Chat Key
    const symmetricKey = await EncryptionService.generateSymmetricKey();
    const groupKey: Record<string, string> = {};
    
    // Encrypt for self
    const myPublicKey = EncryptionService.getStoredPublicKey();
    if (myPublicKey) {
      groupKey[user.uid] = await EncryptionService.encryptSymmetricKey(symmetricKey, myPublicKey);
    }
    
    // Encrypt for other
    if (otherUser.publicKey) {
      groupKey[otherUser.uid] = await EncryptionService.encryptSymmetricKey(symmetricKey, otherUser.publicKey);
    }

    const chatData: Chat = {
      id: chatId,
      type: 'one-to-one',
      participants: [user.uid, otherUser.uid],
      updatedAt: serverTimestamp(),
      name: otherUser.displayName,
      groupKey,
    };

    try {
      await setDoc(doc(db, 'chats', chatId), chatData);
      setActiveChat(chatData);
      setShowNewChatModal(false);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `chats/${chatId}`);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#0f172a] text-white">
        <motion.div 
          animate={{ scale: [1, 1.2, 1], rotate: [0, 10, -10, 0] }}
          transition={{ duration: 2, repeat: Infinity }}
          className="text-4xl font-bold font-display bg-gradient-to-r from-primary to-secondary bg-clip-text text-transparent"
        >
          kai
        </motion.div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#0f172a] text-white p-4 overflow-hidden relative">
        {/* Background blobs */}
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-primary/10 rounded-full blur-[120px] animate-pulse" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-secondary/10 rounded-full blur-[120px] animate-pulse delay-700" />
        
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full max-w-md p-10 rounded-[2.5rem] bg-[#1e293b]/50 backdrop-blur-2xl border border-white/5 shadow-2xl flex flex-col items-center space-y-8 relative z-10"
        >
          <div className="w-24 h-24 bg-gradient-to-tr from-primary to-secondary rounded-3xl flex items-center justify-center shadow-lg shadow-primary/20 rotate-12">
            <MessageSquare size={48} className="text-white -rotate-12" />
          </div>
          
          <div className="text-center space-y-2">
            <h1 className="text-6xl font-bold tracking-tighter bg-gradient-to-r from-primary to-secondary bg-clip-text text-transparent font-display">kai</h1>
            <p className="text-slate-400 font-medium">Next-gen messaging for the bold.</p>
          </div>

          {loginError && (
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="bg-rose-500/10 border border-rose-500/20 text-rose-400 p-4 rounded-2xl text-sm w-full"
            >
              {loginError}
            </motion.div>
          )}

          <button
            onClick={handleLogin}
            disabled={isLoggingIn}
            className={cn(
              "w-full py-4 px-8 bg-white text-[#0f172a] font-bold rounded-2xl transition-all flex items-center justify-center gap-3 hover:scale-[1.02] active:scale-[0.98] shadow-xl shadow-white/5",
              isLoggingIn && "opacity-50 cursor-not-allowed"
            )}
          >
            {isLoggingIn ? (
              <div className="w-5 h-5 border-2 border-[#0f172a] border-t-transparent rounded-full animate-spin" />
            ) : (
              <UserIcon size={20} />
            )}
            {isLoggingIn ? 'Connecting...' : 'Continue with Google'}
          </button>
          
          <p className="text-xs text-slate-500">By continuing, you agree to our Terms & Privacy.</p>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-[#0f172a] text-slate-200 font-sans overflow-hidden">
      {/* Sidebar */}
      <div className={cn(
        "w-full md:w-[400px] flex flex-col border-r border-white/5 bg-[#1e293b]/30 backdrop-blur-xl relative z-20 transition-all duration-300",
        activeChat && "hidden md:flex"
      )}>
        {/* Sidebar Header */}
        <div className="p-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="relative">
              <img src={user.photoURL} alt={user.displayName} className="w-12 h-12 rounded-2xl object-cover ring-2 ring-primary/20" />
              <div className="absolute bottom-0 right-0 w-3 h-3 bg-emerald-500 border-2 border-[#1e293b] rounded-full" />
            </div>
            <div>
              <h3 className="font-bold text-lg leading-tight">{user.displayName}</h3>
              <p className="text-xs text-slate-400 font-medium tracking-wide uppercase">{user.status || 'Online'}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button 
              onClick={() => setShowNewChatModal(true)}
              className="p-2.5 hover:bg-white/5 rounded-xl transition-colors text-primary"
              title="New Chat"
            >
              <Plus size={22} />
            </button>
            <button onClick={handleLogout} className="p-2.5 hover:bg-white/5 rounded-xl transition-colors text-slate-400" title="Logout">
              <LogOut size={20} />
            </button>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="flex border-b border-white/5 px-6 mb-4 gap-6">
          <button 
            onClick={() => setSidebarView('chats')}
            className={cn(
              "pb-3 text-sm font-bold transition-all border-b-2 flex items-center gap-2",
              sidebarView === 'chats' ? "text-primary border-primary" : "text-slate-500 border-transparent hover:text-slate-300"
            )}
          >
            <MessageSquare size={18} />
            Chats
          </button>
          <button 
            onClick={() => setSidebarView('contacts')}
            className={cn(
              "pb-3 text-sm font-bold transition-all border-b-2 flex items-center gap-2",
              sidebarView === 'contacts' ? "text-primary border-primary" : "text-slate-500 border-transparent hover:text-slate-300"
            )}
          >
            <Users size={18} />
            Contacts
          </button>
        </div>

        {/* Search */}
        <div className="px-6 pb-4">
          <div className="bg-white/5 flex items-center px-4 py-3 rounded-2xl border border-white/5 focus-within:border-primary/30 transition-all">
            <Search size={18} className="text-slate-500" />
            <input
              type="text"
              placeholder={sidebarView === 'chats' ? "Search conversations..." : "Search contacts by name or email..."}
              className="bg-transparent border-none focus:ring-0 w-full px-4 text-sm outline-none placeholder:text-slate-600"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
        </div>

        {/* Sidebar Content */}
        <div className="flex-1 overflow-y-auto px-3 space-y-1 custom-scrollbar">
          {sidebarView === 'chats' ? (
            <>
              {chats.filter(c => (c.name || '').toLowerCase().includes(searchTerm.toLowerCase())).map((chat) => {
                const isActive = activeChat?.id === chat.id;
                
                return (
                  <motion.div
                    key={chat.id}
                    whileHover={{ x: 4 }}
                    onClick={() => setActiveChat(chat)}
                    className={cn(
                      "flex items-center p-4 cursor-pointer rounded-2xl transition-all group",
                      isActive ? "bg-primary/10 border border-primary/10" : "hover:bg-white/5"
                    )}
                  >
                    <div className="relative mr-4">
                      <div className="w-14 h-14 rounded-2xl bg-slate-700 flex items-center justify-center overflow-hidden ring-2 ring-transparent group-hover:ring-primary/20 transition-all">
                        {chat.type === 'group' ? (
                          <Users size={24} className="text-primary" />
                        ) : (
                          <UserIcon size={24} className="text-slate-500" />
                        )}
                      </div>
                      {typingUsers[chat.id] && (
                        <div className="absolute -bottom-1 -right-1 bg-primary p-1 rounded-lg animate-bounce">
                          <Smile size={12} className="text-white" />
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between items-baseline mb-1">
                        <h4 className={cn("font-bold truncate", isActive ? "text-primary" : "text-slate-200")}>
                          {chat.name || 'Chat'}
                        </h4>
                        <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                          {chat.updatedAt ? format(chat.updatedAt.toDate(), 'HH:mm') : ''}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <p className="text-sm text-slate-500 truncate font-medium">
                          {typingUsers[chat.id] ? (
                            <span className="text-primary italic animate-pulse">Typing...</span>
                          ) : (
                            decryptedLastMessages[chat.id] || chat.lastMessage?.text || (chat.lastMessage?.mediaUrl ? 'Media' : 'No messages yet')
                          )}
                        </p>
                        {chat.lastMessage?.senderId === user.uid && (
                          <div className="ml-2">
                            {chat.lastMessage.status === 'read' ? (
                              <CheckCheck size={14} className="text-secondary" />
                            ) : (
                              <Check size={14} className="text-slate-600" />
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </motion.div>
                );
              })}

              {chats.length === 0 && (
                <div className="flex flex-col items-center justify-center h-full text-slate-500 p-8 text-center space-y-6">
                  <div className="w-20 h-20 bg-white/5 rounded-3xl flex items-center justify-center">
                    <MessageSquare size={32} className="opacity-20" />
                  </div>
                  <div className="space-y-2">
                    <p className="font-bold text-slate-400">No conversations</p>
                    <p className="text-xs text-slate-600">Start a new chat to begin messaging.</p>
                  </div>
                  <button 
                    onClick={() => setShowNewChatModal(true)}
                    className="bg-primary hover:bg-primary-hover text-white px-6 py-3 rounded-2xl font-bold flex items-center gap-2 transition-all shadow-lg shadow-primary/20"
                  >
                    <Plus size={20} /> New Chat
                  </button>
                </div>
              )}
            </>
          ) : (
            <>
              {allUsers.filter(u => u.displayName.toLowerCase().includes(searchTerm.toLowerCase()) || u.email.toLowerCase().includes(searchTerm.toLowerCase())).map((u) => (
                <motion.div
                  key={u.uid}
                  whileHover={{ x: 4 }}
                  onClick={() => startChat(u)}
                  className="flex items-center p-4 cursor-pointer hover:bg-white/5 rounded-2xl transition-all group"
                >
                  <div className="relative mr-4">
                    <img src={u.photoURL} alt={u.displayName} className="w-14 h-14 rounded-2xl object-cover ring-2 ring-transparent group-hover:ring-primary/20 transition-all" />
                    <div className={cn(
                      "absolute bottom-0 right-0 w-3.5 h-3.5 border-2 border-[#1e293b] rounded-full",
                      u.status === 'online' ? "bg-emerald-500" : "bg-slate-600"
                    )} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h4 className="font-bold text-slate-200 truncate group-hover:text-primary transition-colors">{u.displayName}</h4>
                    <p className="text-xs text-slate-500 truncate font-medium">{u.email}</p>
                  </div>
                  <div className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all">
                    <MessageSquare size={18} className="text-primary" />
                  </div>
                </motion.div>
              ))}

              {allUsers.length === 0 && (
                <div className="py-12 text-center space-y-3">
                  <Users size={40} className="mx-auto text-slate-700 opacity-20" />
                  <p className="text-sm text-slate-500 font-medium">No contacts found</p>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* New Chat Modal */}
      <AnimatePresence>
        {showNewChatModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
            onClick={() => {
              setShowNewChatModal(false);
              setSelectedUsers([]);
              setGroupName('');
              setIsAddingMember(false);
            }}
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              className="bg-[#1e293b] w-full max-w-md rounded-3xl overflow-hidden shadow-2xl border border-white/10"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="p-6 bg-primary text-white flex items-center justify-between">
                <div>
                  <h2 className="text-xl font-bold">{isAddingMember ? 'Add Members' : 'New Conversation'}</h2>
                  <p className="text-xs text-white/70 font-medium">{isAddingMember ? `Add to ${activeChat?.name}` : 'Select users to start chatting'}</p>
                </div>
                <button 
                  onClick={() => {
                    setShowNewChatModal(false);
                    setSelectedUsers([]);
                    setGroupName('');
                    setIsAddingMember(false);
                  }}
                  className="p-2 hover:bg-white/10 rounded-xl transition-colors"
                >
                  <Plus className="rotate-45" size={24} />
                </button>
              </div>
              <div className="p-6 space-y-4">
                {selectedUsers.length > 0 && (
                  <div className="space-y-3 p-4 bg-white/5 rounded-2xl border border-white/5">
                    {!isAddingMember && (
                      <input
                        type="text"
                        placeholder="Group Name (required for group)"
                        className="w-full bg-transparent border-none focus:ring-0 text-sm outline-none text-slate-200 placeholder:text-slate-600 font-bold"
                        value={groupName}
                        onChange={(e) => setGroupName(e.target.value)}
                      />
                    )}
                    <div className="flex flex-wrap gap-2">
                      {selectedUsers.map(u => (
                        <div key={u.uid} className="bg-primary/20 text-primary text-[10px] font-bold px-2 py-1 rounded-lg flex items-center gap-1">
                          {u.displayName}
                          <button onClick={() => setSelectedUsers(prev => prev.filter(user => user.uid !== u.uid))}>
                            <Plus className="rotate-45" size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                    {selectedUsers.length > 0 && (
                      <button 
                        onClick={async () => {
                          if (isAddingMember) {
                            for (const u of selectedUsers) {
                              await addMemberToGroup(u.uid);
                            }
                            setShowNewChatModal(false);
                            setSelectedUsers([]);
                            setIsAddingMember(false);
                          } else {
                            createGroupChat();
                          }
                        }}
                        disabled={!isAddingMember && !groupName.trim()}
                        className="w-full bg-primary hover:bg-primary-hover text-white py-2 rounded-xl text-sm font-bold transition-all disabled:opacity-50"
                      >
                        {isAddingMember ? 'Add to Group' : 'Create Group'}
                      </button>
                    )}
                  </div>
                )}
                <div className="bg-white/5 flex items-center px-4 py-3 rounded-2xl border border-white/5 focus-within:border-primary/30 transition-all">
                  <Search size={18} className="text-slate-500" />
                  <input
                    type="text"
                    placeholder="Search users by name or email..."
                    className="bg-transparent border-none focus:ring-0 w-full px-4 text-sm outline-none placeholder:text-slate-600"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                  />
                </div>
                <div className="max-h-[400px] overflow-y-auto space-y-2 pr-2 custom-scrollbar">
                  {allUsers.filter(u => {
                    const matchesSearch = u.displayName.toLowerCase().includes(searchTerm.toLowerCase()) || u.email.toLowerCase().includes(searchTerm.toLowerCase());
                    if (isAddingMember && activeChat) {
                      return matchesSearch && !activeChat.participants.includes(u.uid);
                    }
                    return matchesSearch;
                  }).map((u) => (
                    <motion.div
                      key={u.uid}
                      whileHover={{ x: 4 }}
                      onClick={() => {
                        if (selectedUsers.some(user => user.uid === u.uid)) {
                          setSelectedUsers(prev => prev.filter(user => user.uid !== u.uid));
                        } else {
                          setSelectedUsers(prev => [...prev, u]);
                        }
                      }}
                      className={cn(
                        "flex items-center p-3 cursor-pointer rounded-2xl transition-all group",
                        selectedUsers.some(user => user.uid === u.uid) ? "bg-primary/10 border border-primary/10" : "hover:bg-white/5"
                      )}
                    >
                      <img src={u.photoURL} alt={u.displayName} className="w-12 h-12 rounded-xl object-cover mr-4 ring-2 ring-transparent group-hover:ring-primary/20 transition-all" />
                      <div className="flex-1 min-w-0">
                        <h4 className="font-bold text-slate-200 truncate group-hover:text-primary transition-colors">{u.displayName}</h4>
                        <p className="text-xs text-slate-500 truncate font-medium">{u.email}</p>
                      </div>
                      {selectedUsers.length === 0 && (
                        <div 
                          onClick={(e) => {
                            e.stopPropagation();
                            startChat(u);
                          }}
                          className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all"
                        >
                          <Plus size={16} className="text-primary" />
                        </div>
                      )}
                    </motion.div>
                  ))}
                  {allUsers.length === 0 && (
                    <div className="py-12 text-center space-y-3">
                      <Users size={40} className="mx-auto text-slate-700 opacity-20" />
                      <p className="text-sm text-slate-500 font-medium">No users found</p>
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main Chat Area */}
      <div className={cn(
        "flex-1 flex flex-col bg-[#0f172a] relative overflow-hidden",
        !activeChat && "hidden md:flex items-center justify-center"
      )}>
        {activeChat ? (
          <>
            {/* Chat Header */}
            <div className="p-4 md:p-6 flex items-center justify-between border-b border-white/5 bg-[#1e293b]/30 backdrop-blur-xl z-10">
              <div className="flex items-center gap-4 flex-1">
                <button 
                  onClick={() => setActiveChat(null)}
                  className="md:hidden p-2 hover:bg-white/5 rounded-xl transition-colors text-slate-400"
                >
                  <Plus className="rotate-45" size={24} />
                </button>
                {!isChatSearchOpen ? (
                  <>
                    <div className="relative">
                      <div className="w-12 h-12 rounded-2xl bg-slate-700 flex items-center justify-center overflow-hidden ring-2 ring-primary/20">
                        <UserIcon size={24} className="text-slate-500" />
                      </div>
                      <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-emerald-500 border-2 border-[#0f172a] rounded-full" />
                    </div>
                    <div>
                      <h3 className="font-bold text-lg leading-tight text-slate-100">{activeChat.name || 'Chat'}</h3>
                      <div className="flex items-center gap-2">
                        <p className="text-xs font-bold text-emerald-500 uppercase tracking-wider">
                          {Object.values(typingUsers).some(Boolean) ? 'typing...' : 'Online'}
                        </p>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="flex-1 flex items-center bg-white/5 px-4 py-2 rounded-xl border border-white/10 focus-within:border-primary/30 transition-all">
                    <Search size={18} className="text-slate-500" />
                    <input
                      type="text"
                      autoFocus
                      placeholder="Search messages..."
                      className="bg-transparent border-none focus:ring-0 w-full px-3 text-sm outline-none placeholder:text-slate-600 text-slate-200"
                      value={chatSearchTerm}
                      onChange={(e) => setChatSearchTerm(e.target.value)}
                    />
                    <button 
                      onClick={() => {
                        setIsChatSearchOpen(false);
                        setChatSearchTerm('');
                      }}
                      className="p-1 hover:bg-white/10 rounded-lg text-slate-400"
                    >
                      <Plus className="rotate-45" size={18} />
                    </button>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2 ml-4">
                {!isChatSearchOpen && (
                  <>
                    {activeChat.type === 'group' && (
                      <button
                        onClick={() => setShowGroupSettings(true)}
                        className="p-2.5 hover:bg-white/5 rounded-xl transition-colors text-slate-400"
                        title="Group Settings"
                      >
                        <Settings size={20} />
                      </button>
                    )}
                    <button
                      onClick={startCall}
                      className="p-2.5 hover:bg-white/5 rounded-xl transition-colors text-slate-400"
                      title="Start Video Call"
                    >
                      <Video size={20} />
                    </button>
                    <button
                      onClick={() => setShowPinnedMessages(!showPinnedMessages)}
                      className={cn(
                        "p-2.5 hover:bg-white/5 rounded-xl transition-all",
                        showPinnedMessages ? "text-primary bg-primary/10" : "text-slate-400"
                      )}
                      title="Pinned Messages"
                    >
                      <Pin size={20} />
                    </button>
                    <button 
                      onClick={() => setIsChatSearchOpen(true)}
                      className="p-2.5 hover:bg-white/5 rounded-xl transition-colors text-slate-400"
                    >
                      <Search size={20} />
                    </button>
                  </>
                )}
                <button className="p-2.5 hover:bg-white/5 rounded-xl transition-colors text-slate-400">
                  <MoreVertical size={20} />
                </button>
              </div>
            </div>

            {/* Group Settings Modal */}
            <AnimatePresence>
              {showGroupSettings && activeChat && activeChat.type === 'group' && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
                  onClick={() => setShowGroupSettings(false)}
                >
                  <motion.div
                    initial={{ scale: 0.9, y: 20 }}
                    animate={{ scale: 1, y: 0 }}
                    exit={{ scale: 0.9, y: 20 }}
                    className="bg-[#1e293b] w-full max-w-lg rounded-3xl overflow-hidden shadow-2xl border border-white/10 flex flex-col max-h-[90vh]"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="p-6 bg-primary text-white flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <Settings size={24} />
                        <div>
                          <h2 className="text-xl font-bold">Group Settings</h2>
                          <p className="text-xs text-white/70 font-medium">Manage members and group info</p>
                        </div>
                      </div>
                      <button 
                        onClick={() => setShowGroupSettings(false)}
                        className="p-2 hover:bg-white/10 rounded-xl transition-colors"
                      >
                        <X size={24} />
                      </button>
                    </div>

                    <div className="flex-1 overflow-y-auto p-6 space-y-8 custom-scrollbar">
                      {/* Group Info Section */}
                      <div className="space-y-4">
                        <div className="flex items-center gap-6">
                          <div className="relative group">
                            <div className="w-24 h-24 rounded-3xl bg-slate-700 flex items-center justify-center overflow-hidden ring-4 ring-primary/20">
                              {activeChat.photoURL ? (
                                <img src={activeChat.photoURL} alt={activeChat.name} className="w-full h-full object-cover" />
                              ) : (
                                <Users size={40} className="text-slate-500" />
                              )}
                            </div>
                            {(activeChat.admins || []).includes(user?.uid || '') && (
                              <>
                                <input 
                                  type="file" 
                                  ref={groupIconInputRef} 
                                  className="hidden" 
                                  accept="image/*"
                                  onChange={handleGroupIconUpload}
                                />
                                <button 
                                  onClick={() => groupIconInputRef.current?.click()}
                                  className="absolute -bottom-2 -right-2 bg-primary p-2 rounded-xl shadow-lg hover:scale-110 transition-transform"
                                >
                                  <Camera size={16} className="text-white" />
                                </button>
                              </>
                            )}
                          </div>
                          <div className="flex-1 space-y-2">
                            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Group Name</label>
                            <input 
                              type="text" 
                              value={activeChat.name}
                              disabled={!(activeChat.admins || []).includes(user?.uid || '')}
                              onChange={(e) => updateGroupSettings({ name: e.target.value })}
                              className="w-full bg-white/5 border border-white/5 focus:border-primary/30 rounded-xl px-4 py-2 text-slate-200 outline-none transition-all disabled:opacity-50"
                            />
                          </div>
                        </div>
                      </div>

                      {/* Members Section */}
                      <div className="space-y-4">
                        <div className="flex items-center justify-between">
                          <h3 className="font-bold text-slate-200 flex items-center gap-2">
                            <Users size={18} className="text-primary" />
                            Members ({activeChat.participants.length})
                          </h3>
                          {(activeChat.admins || []).includes(user?.uid || '') && (
                            <button 
                              onClick={() => {
                                setIsAddingMember(true);
                                setShowNewChatModal(true);
                              }}
                              className="text-xs font-bold text-primary hover:underline flex items-center gap-1"
                            >
                              <UserPlus size={14} /> Add Member
                            </button>
                          )}
                        </div>
                        <div className="space-y-2">
                          {activeChat.participants.map(memberId => {
                            const member = allUsers.find(u => u.uid === memberId) || (memberId === user?.uid ? user : null);
                            if (!member) return null;
                            const isAdmin = (activeChat.admins || []).includes(memberId);
                            const isMe = memberId === user?.uid;
                            const amIAdmin = (activeChat.admins || []).includes(user?.uid || '');

                            return (
                              <div key={memberId} className="flex items-center justify-between p-3 bg-white/5 rounded-2xl border border-white/5 group">
                                <div className="flex items-center gap-3">
                                  <img src={member.photoURL} alt={member.displayName} className="w-10 h-10 rounded-xl object-cover" />
                                  <div>
                                    <div className="flex items-center gap-2">
                                      <p className="text-sm font-bold text-slate-200">{member.displayName} {isMe && '(You)'}</p>
                                      {isAdmin && (
                                        <span className="bg-primary/20 text-primary text-[8px] font-black px-1.5 py-0.5 rounded uppercase tracking-tighter flex items-center gap-0.5">
                                          <Shield size={8} /> Admin
                                        </span>
                                      )}
                                    </div>
                                    <p className="text-[10px] text-slate-500 font-medium">{member.email}</p>
                                  </div>
                                </div>
                                
                                {amIAdmin && !isMe && (
                                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                    {!isAdmin && (
                                      <button 
                                        onClick={() => promoteToAdmin(memberId)}
                                        className="p-2 hover:bg-emerald-500/10 text-emerald-500 rounded-lg transition-colors"
                                        title="Promote to Admin"
                                      >
                                        <Shield size={16} />
                                      </button>
                                    )}
                                    <button 
                                      onClick={() => removeMemberFromGroup(memberId)}
                                      className="p-2 hover:bg-red-500/10 text-red-500 rounded-lg transition-colors"
                                      title="Remove from Group"
                                    >
                                      <UserMinus size={16} />
                                    </button>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Pinned Messages Panel */}
            <AnimatePresence>
              {showPinnedMessages && (
                <motion.div
                  initial={{ x: '100%' }}
                  animate={{ x: 0 }}
                  exit={{ x: '100%' }}
                  className="absolute top-0 right-0 bottom-0 w-full md:w-80 bg-[#1e293b] border-l border-white/5 z-40 shadow-2xl flex flex-col"
                >
                  <div className="p-6 border-b border-white/5 flex items-center justify-between bg-[#1e293b]/50 backdrop-blur-xl">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                        <Pin size={20} className="text-primary" />
                      </div>
                      <h3 className="font-bold text-slate-200">Pinned Messages</h3>
                    </div>
                    <button 
                      onClick={() => setShowPinnedMessages(false)}
                      className="p-2 hover:bg-white/5 rounded-xl transition-colors text-slate-400"
                    >
                      <X size={20} />
                    </button>
                  </div>
                  <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
                    {messages.filter(m => m.isPinned).length === 0 ? (
                      <div className="flex flex-col items-center justify-center h-full text-center space-y-4 opacity-30">
                        <Pin size={48} />
                        <p className="text-sm font-medium">No pinned messages yet</p>
                      </div>
                    ) : (
                      messages.filter(m => m.isPinned).map((msg) => (
                        <div 
                          key={msg.id} 
                          className="p-4 bg-white/5 rounded-2xl border border-white/5 hover:border-primary/30 transition-all cursor-pointer group"
                          onClick={() => {
                            setShowPinnedMessages(false);
                          }}
                        >
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-[10px] font-bold text-primary uppercase tracking-widest">
                              {msg.senderId === user.uid ? 'You' : 'Others'}
                            </span>
                            <button 
                              onClick={(e) => {
                                e.stopPropagation();
                                togglePinMessage(msg);
                              }}
                              className="opacity-0 group-hover:opacity-100 p-1 hover:bg-white/10 rounded-lg transition-all text-slate-500 hover:text-red-400"
                            >
                              <X size={14} />
                            </button>
                          </div>
                          {msg.mediaUrl && (
                            <div className="mb-2 rounded-lg overflow-hidden bg-black/20 aspect-video">
                              {msg.mediaType === 'image' ? (
                                <img src={msg.mediaUrl} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center bg-slate-800">
                                  <File size={24} className="text-slate-600" />
                                </div>
                              )}
                            </div>
                          )}
                          <p className="text-sm text-slate-300 line-clamp-3 font-medium">
                            {msg.text || (msg.mediaUrl ? 'Shared media' : 'Message')}
                          </p>
                          <div className="mt-2 text-[10px] text-slate-600 font-bold uppercase">
                            {msg.createdAt ? format(msg.createdAt.toDate(), 'MMM d, HH:mm') : ''}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Messages */}
            <div 
              ref={scrollRef}
              className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar relative"
            >
              {/* Background Pattern Overlay */}
              <div className="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/cubes.png')] opacity-[0.03] pointer-events-none" />
              <AnimatePresence initial={false}>
                {messages
                  .filter(msg => !chatSearchTerm || (decryptedMessages[msg.id] || msg.text || '').toLowerCase().includes(chatSearchTerm.toLowerCase()))
                  .map((msg, idx) => {
                    const isMe = msg.senderId === user.uid;
                    const displayMessage = decryptedMessages[msg.id] || msg.text;
                  
                  return (
                    <motion.div
                      key={msg.id}
                      initial={{ opacity: 0, x: isMe ? 20 : -20, scale: 0.95 }}
                      animate={{ opacity: 1, x: 0, scale: 1 }}
                      transition={{ duration: 0.2, delay: idx * 0.01 }}
                      className={cn(
                        "flex w-full group",
                        isMe ? "justify-end" : "justify-start"
                      )}
                    >
                      <div className={cn(
                        "flex max-w-[85%] md:max-w-[70%] gap-3",
                        isMe ? "flex-row-reverse" : "flex-row"
                      )}>
                        {!isMe && (
                          <div className="w-8 h-8 rounded-lg bg-slate-800 flex-shrink-0 mt-auto overflow-hidden opacity-0 group-hover:opacity-100 transition-opacity">
                            <UserIcon size={16} className="m-auto text-slate-600" />
                          </div>
                        )}
                        <div className={cn(
                          "relative px-4 py-3 rounded-2xl shadow-lg overflow-hidden",
                          isMe 
                            ? "bg-primary text-white rounded-br-none" 
                            : "bg-slate-800 text-slate-200 rounded-bl-none border border-white/5"
                        )}>
                          {msg.mediaUrl && (
                            <div className="mb-2 -mx-1 -mt-1 rounded-xl overflow-hidden bg-black/20">
                              <DecryptedMedia 
                                msg={msg} 
                                chatKey={chatKey} 
                                onOpen={(url) => window.open(url, '_blank')} 
                              />
                            </div>
                          )}
                          {displayMessage && (
                            <p className="text-sm leading-relaxed font-medium whitespace-pre-wrap break-words">
                              <HighlightText text={displayMessage} highlight={chatSearchTerm} />
                            </p>
                          )}
                          
                          {msg.isPinned && (
                            <div className="flex items-center gap-1 mt-1 opacity-50">
                              <Pin size={10} className="fill-current" />
                              <span className="text-[10px] font-bold uppercase tracking-wider">Pinned</span>
                            </div>
                          )}
                          
                          {msg.translation && (
                            <div className="mt-2 pt-2 border-t border-white/10">
                              <div className="flex items-center gap-1 mb-1 opacity-60">
                                <Sparkles size={10} />
                                <span className="text-[10px] uppercase font-bold tracking-wider">Translated to {LANGUAGES.find(l => l.name === msg.translation?.language || l.code === msg.translation?.language)?.name || msg.translation.language}</span>
                              </div>
                              <p className="text-sm italic opacity-90">{msg.translation.text}</p>
                            </div>
                          )}

                          {/* Reaction Picker (Simple) */}
                          <div className={cn(
                            "absolute top-0 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1 bg-slate-900/90 backdrop-blur-sm p-1 rounded-xl border border-white/10 shadow-xl z-20",
                            isMe ? "right-full mr-2" : "left-full ml-2"
                          )}>
                            {['👍', '❤️', '😂', '😮', '😢', '🔥'].map(emoji => (
                              <button
                                key={emoji}
                                onClick={() => toggleReaction(msg, emoji)}
                                className="hover:scale-125 transition-transform p-1"
                              >
                                {emoji}
                              </button>
                            ))}
                            {msg.text && (
                              <div className="relative">
                                <button
                                  onClick={() => setShowTranslateMenu(showTranslateMenu === msg.id ? null : msg.id)}
                                  className={cn(
                                    "hover:scale-125 transition-transform p-1 text-primary",
                                    translatingMessageId === msg.id && "animate-pulse"
                                  )}
                                  title="Translate"
                                >
                                  <Sparkles size={16} />
                                </button>
                                
                                <AnimatePresence>
                                  {showTranslateMenu === msg.id && (
                                    <motion.div
                                      initial={{ opacity: 0, scale: 0.9, y: 10 }}
                                      animate={{ opacity: 1, scale: 1, y: 0 }}
                                      exit={{ opacity: 0, scale: 0.9, y: 10 }}
                                      className={cn(
                                        "absolute bottom-full mb-2 bg-slate-900 border border-white/10 rounded-xl shadow-2xl p-2 min-w-[120px] z-50",
                                        isMe ? "right-0" : "left-0"
                                      )}
                                    >
                                      <p className="text-[10px] font-bold text-slate-500 uppercase px-2 mb-1">Translate to</p>
                                      <div className="max-h-40 overflow-y-auto custom-scrollbar">
                                        {LANGUAGES.map(lang => (
                                          <button
                                            key={lang.code}
                                            onClick={() => translateMessage(msg, lang.name)}
                                            className="w-full text-left px-2 py-1.5 text-xs text-slate-300 hover:bg-primary/20 hover:text-primary rounded-lg transition-colors"
                                          >
                                            {lang.name}
                                          </button>
                                        ))}
                                      </div>
                                    </motion.div>
                                  )}
                                </AnimatePresence>
                              </div>
                            )}
                            <button
                              onClick={() => togglePinMessage(msg)}
                              className={cn(
                                "hover:scale-125 transition-transform p-1",
                                msg.isPinned ? "text-primary" : "text-slate-400"
                              )}
                              title={msg.isPinned ? "Unpin Message" : "Pin Message"}
                            >
                              <Pin size={16} className={msg.isPinned ? "fill-current" : ""} />
                            </button>
                            {isMe && (
                              <button
                                onClick={() => deleteMessage(msg)}
                                className="hover:scale-125 transition-transform p-1 text-red-500 hover:text-red-400"
                                title="Delete Message"
                              >
                                <Trash2 size={16} />
                              </button>
                            )}
                          </div>

                          {/* Reactions Display */}
                          {msg.reactions && Object.keys(msg.reactions).length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-2">
                              {Object.entries(msg.reactions).map(([emoji, userIds]) => {
                                const ids = userIds as string[];
                                return (
                                  <button
                                    key={emoji}
                                    onClick={() => toggleReaction(msg, emoji)}
                                    className={cn(
                                      "px-1.5 py-0.5 rounded-lg text-xs flex items-center gap-1 transition-all",
                                      ids.includes(user.uid) 
                                        ? "bg-primary/20 border border-primary/30 text-primary" 
                                        : "bg-black/20 border border-white/5 text-slate-400"
                                    )}
                                  >
                                    <span>{emoji}</span>
                                    <span className="font-bold">{ids.length}</span>
                                  </button>
                                );
                              })}
                            </div>
                          )}

                          <div className={cn(
                            "flex items-center gap-1.5 mt-1.5 justify-end",
                            isMe ? "text-white/60" : "text-slate-500"
                          )}>
                            <span className="text-[10px] font-bold uppercase tracking-tighter">
                              {msg.createdAt ? format(msg.createdAt.toDate(), 'HH:mm') : ''}
                            </span>
                            {isMe && (
                              <div className="flex items-center">
                                {msg.status === 'read' ? (
                                  <CheckCheck size={12} className="text-secondary" />
                                ) : msg.status === 'delivered' ? (
                                  <CheckCheck size={12} className="text-white/40" />
                                ) : (
                                  <Check size={12} className="text-white/40" />
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>

            {/* Input Area */}
            <div className="p-4 md:p-6 bg-[#0f172a] relative">
              {isUploading && (
                <div className="absolute inset-0 bg-[#0f172a]/80 backdrop-blur-sm z-20 flex items-center justify-center gap-3">
                  <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                  <p className="text-sm font-bold text-slate-300">Uploading media...</p>
                </div>
              )}
              {isRecording ? (
                <div className="bg-slate-800/50 backdrop-blur-md border border-primary/30 p-2 rounded-3xl flex items-center gap-4 shadow-xl animate-pulse">
                  <div className="flex items-center gap-3 px-4 flex-1">
                    <div className="w-3 h-3 bg-red-500 rounded-full animate-ping" />
                    <span className="text-sm font-bold text-slate-200 tabular-nums">Recording: {formatTime(recordingTime)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button 
                      onClick={cancelRecording}
                      className="p-3 hover:bg-red-500/20 rounded-2xl transition-colors text-red-400"
                      title="Cancel"
                    >
                      <Trash2 size={22} />
                    </button>
                    <button 
                      onClick={stopRecording}
                      className="p-3 bg-primary hover:bg-primary-hover rounded-2xl transition-colors text-white shadow-lg shadow-primary/20"
                      title="Send Voice Message"
                    >
                      <Square size={22} />
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <form 
                    onSubmit={sendMessage} 
                    className="bg-slate-800/50 backdrop-blur-md border border-white/5 p-2 rounded-3xl flex items-center gap-2 shadow-xl focus-within:border-primary/30 transition-all"
                  >
                    <button type="button" className="p-3 hover:bg-white/5 rounded-2xl transition-colors text-slate-400">
                      <Smile size={22} />
                    </button>
                    <input
                      type="file"
                      ref={fileInputRef}
                      className="hidden"
                      accept="image/*,video/*"
                      onChange={handleFileSelect}
                    />
                    <button 
                      type="button" 
                      onClick={() => fileInputRef.current?.click()}
                      className="p-3 hover:bg-white/5 rounded-2xl transition-colors text-slate-400"
                    >
                      <Paperclip size={22} />
                    </button>
                    <input
                      type="text"
                      placeholder="Write a message..."
                      className="flex-1 bg-transparent border-none rounded-xl px-2 py-3 text-sm outline-none focus:ring-0 text-slate-200 placeholder:text-slate-600 font-medium"
                      value={newMessage}
                      onChange={handleTyping}
                    />
                    {!newMessage.trim() && (
                      <button 
                        type="button"
                        onClick={startRecording}
                        className="p-3 hover:bg-primary/20 rounded-2xl transition-all text-primary"
                        title="Record Voice Message"
                      >
                        <Mic size={22} />
                      </button>
                    )}
                    <button 
                      type="button"
                      onClick={rephraseText}
                      disabled={!newMessage.trim() || isRephrasing}
                      className={cn(
                        "p-3 rounded-2xl transition-all text-slate-400 hover:bg-white/5",
                        isRephrasing && "animate-pulse text-primary"
                      )}
                      title="Rephrase with AI"
                    >
                      <Sparkles size={22} className={cn(isRephrasing && "animate-spin")} />
                    </button>
                    <button 
                      type="submit" 
                      disabled={!newMessage.trim() && !isUploading}
                      className={cn(
                        "p-3 rounded-2xl transition-all shadow-lg",
                        newMessage.trim() 
                          ? "bg-primary text-white shadow-primary/20 hover:scale-105 active:scale-95" 
                          : "bg-slate-700 text-slate-500 cursor-not-allowed"
                      )}
                    >
                      <Send size={22} />
                    </button>
                    <button 
                      type="button"
                      onClick={() => setShowScheduler(!showScheduler)}
                      className={cn(
                        "p-3 rounded-2xl transition-all text-slate-400 hover:bg-white/5",
                        showScheduler && "text-primary bg-primary/10"
                      )}
                      title="Schedule Message"
                    >
                      <Clock size={22} />
                    </button>
                  </form>
                  
                  {/* Scheduler Popup */}
                  <AnimatePresence>
                    {showScheduler && (
                      <motion.div
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 10 }}
                        className="absolute bottom-24 right-4 bg-[#1e293b] border border-white/10 rounded-3xl p-6 shadow-2xl w-80 z-50"
                      >
                        <div className="flex items-center gap-3 mb-6">
                          <div className="w-10 h-10 bg-primary/10 rounded-xl flex items-center justify-center text-primary">
                            <Calendar size={20} />
                          </div>
                          <div>
                            <h4 className="font-bold text-slate-200">Schedule Message</h4>
                            <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Choose date and time</p>
                          </div>
                        </div>
                        <div className="space-y-4">
                          <div className="space-y-2">
                            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest ml-1">Send At</label>
                            <input 
                              type="datetime-local" 
                              className="w-full bg-black/20 border border-white/5 rounded-xl px-4 py-3 text-sm text-slate-200 focus:border-primary/30 focus:ring-0 transition-all outline-none"
                              value={scheduledTime}
                              onChange={(e) => setScheduledTime(e.target.value)}
                            />
                          </div>
                          <button 
                            onClick={scheduleMessage}
                            disabled={!scheduledTime || !newMessage.trim()}
                            className="w-full bg-primary text-white py-3 rounded-xl font-black text-xs uppercase tracking-widest hover:bg-primary-hover transition-all shadow-lg shadow-primary/20 disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            Confirm Schedule
                          </button>
                          <button 
                            onClick={() => setShowScheduler(false)}
                            className="w-full bg-white/5 text-slate-400 py-3 rounded-xl font-black text-xs uppercase tracking-widest hover:bg-white/10 transition-all"
                          >
                            Cancel
                          </button>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </>
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center justify-center h-full p-12 text-center space-y-8 max-w-md mx-auto">
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.5, type: "spring" }}
              className="relative"
            >
              <div className="absolute inset-0 bg-primary/20 blur-3xl rounded-full" />
              <div className="relative w-32 h-32 bg-gradient-to-br from-primary to-primary-hover rounded-[40px] flex items-center justify-center shadow-2xl shadow-primary/30 transform rotate-12">
                <MessageSquare size={64} className="text-white -rotate-12" />
              </div>
            </motion.div>
            <div className="space-y-3">
              <h2 className="text-3xl font-black text-white tracking-tight">Welcome to kai</h2>
              <p className="text-slate-500 font-medium leading-relaxed">
                Connect with your friends in real-time with our secure, end-to-end encrypted messaging platform.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-4 w-full">
              <div className="p-4 bg-white/5 rounded-2xl border border-white/5 text-left space-y-2">
                <div className="w-8 h-8 bg-primary/10 rounded-lg flex items-center justify-center text-primary">
                  <Smile size={18} />
                </div>
                <p className="text-xs font-bold text-slate-300 uppercase tracking-wider">Expressive</p>
                <p className="text-[10px] text-slate-500 leading-tight">Share your feelings with emojis and reactions.</p>
              </div>
              <div className="p-4 bg-white/5 rounded-2xl border border-white/5 text-left space-y-2">
                <div className="w-8 h-8 bg-secondary/10 rounded-lg flex items-center justify-center text-secondary">
                  <CheckCheck size={18} />
                </div>
                <p className="text-xs font-bold text-slate-300 uppercase tracking-wider">Reliable</p>
                <p className="text-[10px] text-slate-500 leading-tight">Real-time delivery status and read receipts.</p>
              </div>
            </div>
            <button 
              onClick={() => setShowNewChatModal(true)}
              className="bg-white text-slate-900 px-8 py-4 rounded-2xl font-black text-sm uppercase tracking-widest hover:bg-slate-200 transition-all shadow-xl active:scale-95"
            >
              Start New Chat
            </button>
          </div>
        )}
      </div>
      {/* Incoming Call Notification */}
      <AnimatePresence>
        {callStatus === 'incoming' && incomingCall && (
          <motion.div
            initial={{ y: -100, opacity: 0 }}
            animate={{ y: 20, opacity: 1 }}
            exit={{ y: -100, opacity: 0 }}
            className="fixed top-0 left-1/2 -translate-x-1/2 z-[100] bg-[#1e293b] border border-white/10 rounded-3xl p-4 shadow-2xl flex items-center gap-4 min-w-[320px]"
          >
            <div className="w-12 h-12 rounded-2xl overflow-hidden ring-2 ring-primary/20">
              <img src={incomingCall.photoURL} alt={incomingCall.name} className="w-full h-full object-cover" />
            </div>
            <div className="flex-1">
              <h4 className="font-bold text-slate-200">{incomingCall.name}</h4>
              <p className="text-xs text-slate-500 font-medium">Incoming {incomingCall.isGroup ? 'group ' : ''}video call...</p>
            </div>
            <div className="flex items-center gap-2">
              <button 
                onClick={endCall}
                className="p-3 bg-red-500 hover:bg-red-600 text-white rounded-2xl transition-all shadow-lg shadow-red-500/20"
              >
                <PhoneOff size={20} />
              </button>
              <button 
                onClick={answerCall}
                className="p-3 bg-emerald-500 hover:bg-emerald-600 text-white rounded-2xl transition-all shadow-lg shadow-emerald-500/20 animate-bounce"
              >
                <Phone size={20} />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Active Call UI */}
      <AnimatePresence>
        {(callStatus === 'active' || callStatus === 'calling') && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[110] bg-[#0f172a] flex flex-col items-center justify-center p-4 md:p-8"
          >
            <div className="relative w-full h-full max-w-6xl aspect-video bg-black rounded-[40px] overflow-hidden shadow-2xl border border-white/5">
              {/* Remote Video */}
              {remoteStream ? (
                <video
                  autoPlay
                  playsInline
                  ref={(el) => { if (el) el.srcObject = remoteStream; }}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center space-y-6">
                  <div className="w-32 h-32 rounded-[40px] bg-slate-800 flex items-center justify-center ring-4 ring-primary/20 animate-pulse">
                    <UserIcon size={64} className="text-slate-600" />
                  </div>
                  <div className="text-center space-y-2">
                    <h3 className="text-2xl font-black text-white tracking-tight">
                      {callStatus === 'calling' ? 'Calling...' : 'Connecting...'}
                    </h3>
                    <p className="text-slate-500 font-medium">Waiting for others to join</p>
                  </div>
                </div>
              )}

              {/* Local Video (Picture-in-Picture) */}
              <div className="absolute top-6 right-6 w-32 md:w-64 aspect-video bg-slate-900 rounded-3xl overflow-hidden shadow-2xl border border-white/10 ring-4 ring-black/50">
                {localStream && (
                  <video
                    autoPlay
                    playsInline
                    muted
                    ref={(el) => { if (el) el.srcObject = localStream; }}
                    className={cn("w-full h-full object-cover", isVideoOff && "hidden")}
                  />
                )}
                {isVideoOff && (
                  <div className="w-full h-full flex items-center justify-center bg-slate-800">
                    <VideoOff size={24} className="text-slate-600" />
                  </div>
                )}
              </div>

              {/* Call Controls */}
              <div className="absolute bottom-10 left-1/2 -translate-x-1/2 flex items-center gap-4 md:gap-6 bg-black/40 backdrop-blur-2xl p-4 md:p-6 rounded-[32px] border border-white/10">
                <button 
                  onClick={toggleAudio}
                  className={cn(
                    "p-4 rounded-2xl transition-all shadow-lg",
                    isAudioMuted ? "bg-red-500 text-white" : "bg-white/10 text-white hover:bg-white/20"
                  )}
                >
                  {isAudioMuted ? <VolumeX size={24} /> : <Volume2 size={24} />}
                </button>
                <button 
                  onClick={toggleVideo}
                  className={cn(
                    "p-4 rounded-2xl transition-all shadow-lg",
                    isVideoOff ? "bg-red-500 text-white" : "bg-white/10 text-white hover:bg-white/20"
                  )}
                >
                  {isVideoOff ? <VideoOff size={24} /> : <Video size={24} />}
                </button>
                <button 
                  onClick={endCall}
                  className="p-4 bg-red-500 hover:bg-red-600 text-white rounded-2xl transition-all shadow-xl shadow-red-500/20 flex items-center gap-3 px-8"
                >
                  <PhoneOff size={24} />
                  <span className="font-black text-sm uppercase tracking-widest hidden md:inline">End Call</span>
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
