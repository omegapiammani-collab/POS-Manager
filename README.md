# POS Manager

API สินค้าและรับสินค้าสำหรับพัฒนาในเครื่อง ใช้ Python 3.10 ขึ้นไปและ SQLite

```sh
python3 -m unittest -v
python3 inventory_api.py
```

API รับคำขอที่ `http://127.0.0.1:8000` และเก็บข้อมูลใน `inventory.sqlite3`
ใช้ `--database` เพื่อระบุไฟล์ฐานข้อมูลและ `--port` เพื่อเปลี่ยนพอร์ต

| วิธี | เส้นทาง | ข้อมูล |
| --- | --- | --- |
| GET | `/products?q=W01` | ค้นชื่อหรือรหัส แสดงหน่วยขาย ยอดคงเหลือ ต้นทุนเฉลี่ย และสถานะสินค้าใกล้หมด |
| POST | `/products` | `code`, `name`, `base_unit`, `price`, `minimum_quantity` (ไม่บังคับ) |
| POST | `/products/{id}/units` | `name`, `multiplier`, `price` |
| POST | `/products/{id}/receipts` | `unit_id`, `quantity`, `unit_cost` |
| GET | `/products/{id}/receipts` | ประวัติรับสินค้า เรียงจากรายการล่าสุด |

ส่งข้อมูล POST ด้วย `Content-Type: application/json` ต้นทุนรับเข้าเป็นราคาทุนต่อหน่วยที่เลือก
เช่น รับน้ำดื่ม 1 แพ็ก ราคาทุนแพ็กละ 120 บาท ให้ส่ง `quantity` เป็น 1 และ `unit_cost` เป็น 120
หากแพ็กมี 12 ขวด ระบบเพิ่มสต๊อก 12 ขวดในหน่วยสต๊อก

รุ่นนี้ใช้ทดสอบในเครื่อง ส่วนบัญชีเจ้าของร้าน การซิงก์ และการป้องกันรายการซ้ำเมื่อส่งคำขอเดิมเป็นงานขั้นถัดไป
