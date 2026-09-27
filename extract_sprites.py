import cv2
import numpy as np

# Load Pose A (base studio image)
img_a = cv2.imread('c:/gerryy/public/jerry-pose-a.jpg')
h, w = img_a.shape[:2]

# In Pose A:
# Head roughly bounds: y from ~3% to ~58%, x from ~28% to ~68%
# Left Eye center: (x=455, y=325) -> approx (w*0.455, h*0.325)
# Right Eye center: (x=505, y=275) -> approx (w*0.505, h*0.275)
# Eyebrows: y from ~15% to ~28%

# 1. Extract Head with smooth alpha mask
head_mask = np.zeros((h, w), dtype=np.float32)
# Ellipse around head
cv2.ellipse(head_mask, (int(w*0.475), int(h*0.31)), (int(w*0.19), int(h*0.28)), 0, 0, 360, 1.0, -1)
head_mask = cv2.GaussianBlur(head_mask, (45, 45), 0)

# 2. Extract Eyes region
eyes_mask = np.zeros((h, w), dtype=np.float32)
cv2.ellipse(eyes_mask, (int(w*0.485), int(h*0.31)), (int(w*0.09), int(h*0.08)), -5, 0, 360, 1.0, -1)
eyes_mask = cv2.GaussianBlur(eyes_mask, (21, 21), 0)

# Save transparent head PNG
head_rgba = cv2.cvtColor(img_a, cv2.COLOR_BGR2BGRA)
head_rgba[:, :, 3] = (head_mask * 255).astype(np.uint8)

# Crop head bounding box to make lightweight sprite
ymin, ymax = int(h*0.02), int(h*0.60)
xmin, xmax = int(w*0.26), int(w*0.69)

cropped_head = head_rgba[ymin:ymax, xmin:xmax]
cv2.imwrite('c:/gerryy/public/jerry-head.png', cropped_head)

# Also create natural blinking / squinting eye overlay
eyes_rgba = cv2.cvtColor(img_a, cv2.COLOR_BGR2BGRA)
eyes_rgba[:, :, 3] = (eyes_mask * 255).astype(np.uint8)
cropped_eyes = eyes_rgba[int(h*0.20):int(h*0.40), int(w*0.38):int(w*0.58)]
cv2.imwrite('c:/gerryy/public/jerry-eyes.png', cropped_eyes)

print('Extracted head sprite:', cropped_head.shape)
