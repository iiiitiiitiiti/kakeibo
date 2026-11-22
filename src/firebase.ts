import { initializeApp } from "firebase/app";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  type Firestore,
} from "firebase/firestore";

// Web 用の接続設定。公開されてよい値で、読み書きの可否は firestore.rules が決める
const firebaseConfig = {
  apiKey: "AIzaSyAGMkQkHJDRBGxFCnUXlnacZLMxDTalkv0",
  authDomain: "kakeibo-c2f4e1.firebaseapp.com",
  projectId: "kakeibo-c2f4e1",
  storageBucket: "kakeibo-c2f4e1.firebasestorage.app",
  messagingSenderId: "980175553517",
  appId: "1:980175553517:web:3337178db93a706ecb5de4",
};

let db: Firestore | null = null;

/** 電波が弱い場所でも記録できるよう、端末に写しを持つ設定で開く */
export function getDb(): Firestore {
  if (db) return db;
  const app = initializeApp(firebaseConfig);
  try {
    db = initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
  } catch {
    // 端末に写しを持てない環境（プライベートブラウズなど）では写しなしで開く
    db = initializeFirestore(app, {});
  }
  return db;
}
