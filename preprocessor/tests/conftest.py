import os

# 시험 중에는 위키백과 요청을 보내지 않는다(단원 웹 용어 — webterms.gather가 바로 None)
os.environ.setdefault("ONEQ_NO_WEB", "1")
