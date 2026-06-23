# Tidraiwa (ติดไรวะ)

แอพรายงานสภาพจราจรวิภาวดี — React + Vite + Firebase Firestore

## โครงสร้างโปรเจกต์

- `src/Tidraiwa.jsx` — โค้ดแอพหลักทั้งหมด (UI, logic)
- `src/firebase.js` — การเชื่อมต่อ Firebase + storage wrapper functions
- `src/main.jsx` — entry point ของ React
- `firestore.rules` — security rules สำหรับ Firestore (ดูคำเตือนด้านล่าง)

## ⚠️ สิ่งที่ต้องทำก่อนใช้งานจริง (สำคัญ)

1. **Firestore test-mode rules หมดอายุใน 30 วัน** หลังจากสร้าง database
   ต้องเข้า Firebase console → Firestore Database → Rules → ปะ rules จาก
   `firestore.rules` ในโปรเจกต์นี้ → Publish ก่อนวันที่หมดอายุ ไม่อย่างนั้น
   แอพจะอ่าน/เขียนข้อมูลไม่ได้เลย

2. **ADMIN_PASSWORD เป็นค่าคงที่ในโค้ด** (`src/Tidraiwa.jsx` บรรทัดบนๆ)
   ค่าเริ่มต้นคือ `"1234"` — เปลี่ยนเป็นรหัสที่คาดเดายากกว่านี้ก่อนแชร์ลิงก์
   ให้คนอื่นใช้งานจริง

3. **ไม่มี real access control** — ข้อมูลทั้งหมดอยู่ใน Firestore collection
   เดียว (`tidraiwa_data`) ที่ client ทุกตัวอ่าน/เขียนได้ผ่าน rules แบบเปิด
   (`allow read, write: if true`) ข้อมูล user encrypted ไว้แล้ว (ดูใน
   Tidraiwa.jsx) แต่ key เข้ารหัสมาจาก ADMIN_PASSWORD ที่อยู่ใน client code
   เช่นกัน — นี่คือข้อจำกัดที่ทราบอยู่แล้วของสถาปัตยกรรมแบบนี้ ไม่ใช่บั๊ก

## วิธี deploy (GitHub → Vercel)

### 1. อัปโหลดโปรเจกต์นี้ขึ้น GitHub

```bash
cd tidraiwa-app
git init
git add .
git commit -m "initial commit"
```

จากนั้นไปสร้าง repository ใหม่บน github.com (กด "New repository" ตั้งชื่อ
เช่น `tidraiwa`) แล้วทำตามคำสั่งที่ GitHub แสดงให้ (จะมีลักษณะคล้าย):

```bash
git remote add origin https://github.com/<your-username>/tidraiwa.git
git branch -M main
git push -u origin main
```

### 2. Deploy ผ่าน Vercel

1. ไปที่ vercel.com → Sign up / Log in **ด้วย GitHub account**
2. กด "Add New..." → "Project"
3. เลือก repository `tidraiwa` ที่อัปโหลดไว้
4. Vercel จะตรวจพบว่าเป็นโปรเจกต์ Vite อัตโนมัติ — ไม่ต้องแก้ค่าตั้งต้นอะไร
5. กด "Deploy"
6. รอสักครู่ จะได้ URL เช่น `tidraiwa.vercel.app`

### 3. ทดสอบ

เปิด URL ที่ได้บนมือถือ ลองลงทะเบียน ลองกดรายงาน ถ้าข้อมูลขึ้นตรงกันทั้ง
สองเครื่อง (เปิดจากมือถือ 2 เครื่องพร้อมกัน) แสดงว่า Firebase เชื่อมถูกต้อง

### 4. (ทางเลือก) เพิ่มไปยังหน้าจอหลักมือถือ (PWA-style)

เปิด URL ในเบราว์เซอร์มือถือ → เมนู → "Add to Home Screen" / "เพิ่มไปยัง
หน้าจอหลัก" จะได้ไอคอนแอพบนมือถือเหมือนแอพจริง (ยังไม่ใช่ .apk)

## หากต้องการไฟล์ .apk จริง

ต้องใช้ Capacitor (https://capacitorjs.com) wrap เว็บแอพที่ deploy แล้วเป็น
Android project แล้ว build ผ่าน Android Studio บนคอมพิวเตอร์ — เป็นขั้นตอน
เพิ่มเติมที่ต้องทำนอกเหนือจากนี้ และต้องมี Android Studio ติดตั้งไว้
