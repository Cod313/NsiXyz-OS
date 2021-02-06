import firebase from "firebase";

const firebaseConfig = {
  apiKey: "AIzaSyChjRnzPZhBcl_gvWMFP1GZg87kh0kqyBc",
  authDomain: "nsixyz.firebaseapp.com",
  projectId: "nsixyz",
  storageBucket: "nsixyz.appspot.com",
  messagingSenderId: "417882642825",
  appId: "1:417882642825:web:4c214289b48f40fd2f6958",
  measurementId: "G-6BSHHGK4KB",
};

firebase.initializeApp(firebaseConfig);

export var messaging = firebase.messaging.isSupported()
  ? firebase.messaging()
  : null;

export default firebase;
