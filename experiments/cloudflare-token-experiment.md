# การทดลองตรวจลายเซ็น Cloudflare Access แบบออฟไลน์

การทดลองนี้ใช้ PyJWT และ cryptography ตรวจ JWT ที่เซ็นด้วยกุญแจ RSA **จำลอง** และเชื่อมผลเข้ากับ backend **จำลอง** ไม่ import จาก POS server และไม่มีบัญชี การล็อกอิน การรับ header จาก Cloudflare การดึง JWKS จากเครือข่าย หรือการ deploy จึงยังไม่ใช่ remote access ที่ใช้งานจริง

สร้าง `AccessTokenVerifier` ด้วย issuer, audience, subject เจ้าของ และ JWKS snapshot ที่จัดเตรียมภายในเทสต์เท่านั้น verifier จำกัด issuer ให้อยู่ในรูป HTTPS ของ `cloudflareaccess.com`, จำกัด algorithm เป็น RS256, เลือกกุญแจตาม kid, ตรวจลายเซ็น issuer audience subject expiry และ not-before และปฏิเสธกุญแจซ้ำ กุญแจที่ไม่รู้จัก หรือข้อมูลกำหนดค่าที่ไม่ถูกต้อง หากเปลี่ยนกุญแจต้องสร้าง verifier ใหม่จาก snapshot ใหม่ การทดลองไม่ทำ HTTP request และไม่มี URL สำหรับดึงกุญแจ จึงไม่ได้ทดลองการดึง JWKS หรือการป้องกัน SSRF ของตัวดึงข้อมูลจริง

รันแยกด้วย Python 3.12 ในสภาพแวดล้อมทดสอบที่ติดตั้ง `experiments/requirements-auth-test.txt` แล้ว:

```sh
python -m unittest experiments.test_cloudflare_token_experiment -v
```

เทสต์สร้างกุญแจใหม่ชั่วคราวในหน่วยความจำและทดสอบ token ถูกต้อง ปลอม หมดอายุ ยังไม่เริ่มใช้ issuer/audience/subject ผิด algorithm ผิด และช่วงเปลี่ยนกุญแจ ไม่มีข้อมูลร้านหรือบัญชีจริง CI มี job แยกสำหรับ dependency ทดลอง; POS เดิมยังไม่มี dependency เหล่านี้

ก่อนนำแนวทางนี้เข้าสู่ระบบจริงยังต้องเลือกและอนุมัติ provider ออกแบบการรับ token จาก `Cf-Access-Jwt-Assertion` โดยป้องกันการข้าม proxy, HTTPS และ CORS/CSRF, สร้างตัวโหลด JWKS จาก endpoint ที่กำหนดไว้ล่วงหน้าเท่านั้นพร้อม TLS validation, จำกัด timeout/cache/ขนาด response และ redirect, ทดสอบการหมุนและการถอนกุญแจ/สิทธิ์ในสภาวะเครือข่ายล้มเหลว รวมถึงตรวจว่า claims ที่ต้องการมีจริงใน integration ของบัญชีเป้าหมาย นอกจากนี้ต้องออกแบบ session, การกู้บัญชีและเพิกถอนอุปกรณ์ และทดสอบทุก endpoint กับบริการทดสอบจริงก่อนตัดสินใจ deploy ไม่สามารถรับประกันค่าใช้จ่าย 0 บาทต่อเนื่องจากผลทดลองนี้

อ้างอิง: [Cloudflare Access: Validate JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/) และ [PyJWT API](https://pyjwt.readthedocs.io/en/latest/api.html)

## การต่อ handler ในหน่วยความจำ

`access_handler_experiment.py` ทดลองตรวจ `Cf-Access-Jwt-Assertion` ด้วย verifier ก่อนส่งต่อไปยัง `InventoryHandler` จริง รวมเส้นทาง asset, API และสำรองฐาน โดยยังคง local Host/peer guard เดิม ใช้ `MemoryTransport` ที่เป็น byte buffer เท่านั้นและปฏิเสธ socket จริง คลาสนี้ไม่ถูก import โดยเซิร์ฟเวอร์ปกติ ไม่สามารถเปิดเป็นบริการเครือข่าย และไม่ใช่การติดตั้ง Cloudflare Access จริง

`test_access_handler_experiment.py` ใช้กุญแจ RSA และฐาน SQLite ชั่วคราว ทดสอบ signed owner ผ่านการอ่าน เขียน asset และสำรอง; คำขอไม่ผ่าน การปลอม identity header, token ไม่ถูกต้อง, key rotation, Host/Origin ซ้ำหรือผิด และ path กำกวมถูกปฏิเสธก่อน dispatch. รันร่วมกับเทสต์ verifier ใน auth-experiment CI job เท่านั้น

ข้อจำกัดยังคงเดิม: ไม่มี TLS, proxy ที่เชื่อถือได้, การป้องกัน bypass ตัวกลาง, โหลด/หมุน JWKS จากเครือข่าย, session revocation หรือขั้นตอน login ทดสอบในหน่วยความจำไม่พิสูจน์การติดตั้งผ่านเบราว์เซอร์หรือเครื่องจริง อีกทั้ง origin และรูปแบบ token ที่ใช้เป็นข้อมูลจำลอง ต้องตรวจและออกแบบ integration จริงก่อนใช้งาน ระหว่างนั้นห้ามนำ handler นี้ไปเปิดผ่านอินเทอร์เน็ต

## การทดลองดึงและหมุนกุญแจ

`cloudflare_jwks_experiment.py` เป็นการทดลองแยกที่มีตัวดึงกุญแจจริง แต่ไม่มี entry point เริ่มบริการ ไม่ถูกเรียกโดย POS และเทสต์ทั้งหมดจำลอง transport โดยไม่ติดต่อ Cloudflare ตัวดึงสร้าง URL จาก issuer แบบ `https://<team>.cloudflareaccess.com` และ path `/cdn-cgi/access/certs` ที่กำหนดตายตัว ไม่รับ URL จาก token หรือผู้เรียก ใช้ TLS ตรวจใบรับรองและ hostname ไม่ใช้ proxy ไม่ตาม redirect ปฏิเสธ DNS ที่ไม่เป็น public จำกัดเวลาและขนาด response และอ่านเฉพาะ `keys` จาก response ที่อาจมี `public_cert` และ `public_certs` เพิ่มเติม

แคชมีอายุไม่เกิน 5 นาทีและจำกัดความถี่การ refresh เมื่อพบ kid ใหม่ หาก refresh ที่จำเป็นล้มเหลวจะปฏิเสธคำขอ ไม่ใช้กุญแจหมดอายุเป็น fallback การจำกัดความถี่อาจทำให้ token ที่ใช้กุญแจใหม่ถูกปฏิเสธชั่วคราว และการถอนกุญแจอาจยังไม่สะท้อนจนกว่า cache จะหมดอายุ DNS ที่ค้างเกินเวลาอาจเหลือ daemon worker ได้สูงสุดหนึ่งตัวต่อตัวดึงและจะไม่เริ่ม worker ใหม่จนกว่าจะเสร็จ การทดสอบยังไม่พิสูจน์การเชื่อม TLS/DNS กับบริการจริงหรือการเพิกถอน session

เทสต์ loopback แยกใช้ HTTP socket ที่ `127.0.0.1` พอร์ตสุ่ม ฐานข้อมูลชั่วคราว และ token ที่เซ็นด้วยกุญแจทดสอบ ไม่เปิดพอร์ตสาธารณะหรือเรียกบริการจริง และไม่เปลี่ยนค่าเริ่มต้นของ POS การใช้งานจริงยังต้องป้องกันการเข้าถึง origin โดยตรงและออกแบบ identity/session/การเพิกถอนก่อนนำไปใช้

## Pipeline ทดลองแบบครบเส้นทาง

`isolated_access_server.py` ประกอบตัวดึงกุญแจ ตัวตรวจ token แบบหมุนกุญแจ policy เจ้าของ และ POS handler จริงเข้าด้วยกัน โดยไม่มี CLI และสร้างฐานข้อมูลเปล่าในโฟลเดอร์ชั่วคราวเองเสมอ รับเฉพาะการเชื่อมต่อโดยตรงบน `127.0.0.1` พอร์ตที่ระบบเลือก และปิด socket/ลบฐานเมื่อออกจาก context ไม่มีตัวเลือกให้ใช้ฐานร้านหรือ bind อินเทอร์เน็ต **ห้ามนำไปต่อผ่าน proxy หรือ tunnel**

ชุดทดสอบ patch เฉพาะการดึง JWKS จึงไม่ติดต่อ Cloudflare ใช้ token RSA ที่เซ็นจริงและ HTTP loopback กับฐานจำลองเพื่อตรวจ request ที่ไม่มีสิทธิ์ การเขียนสินค้า/อ่าน/สำรองที่ผ่าน guard การเปลี่ยนกุญแจ และการปฏิเสธเมื่อแคชหมดอายุแล้วดึงกุญแจไม่ได้ ตัว factory สามารถเรียกตัวดึง HTTPS จริงได้หากผู้พัฒนาจงใจเรียกนอกเทสต์ แต่การทดลองนี้ไม่ได้ทำเช่นนั้นและยังไม่เคยเชื่อมบัญชี Cloudflare จริง

นี่ไม่ใช่ flow ลงชื่อเข้าใช้: เบราว์เซอร์ไม่ได้รับ assertion อัตโนมัติ ไม่มี identity provider, TLS จากอุปกรณ์, การป้องกัน bypass origin, การเพิกถอน session หรือการยืนยันต้นทุนฟรี จึงยังไม่ใช่ระบบ remote access ที่ปลอดภัยสำหรับร้านจริง และไม่เปลี่ยนเซิร์ฟเวอร์ POS ปกติ
