# Label Studio (Custom Fork)

HumanSignal Label Studio를 기반으로 커스터마이징한 데이터 라벨링 플랫폼입니다.
주로 대용량 비디오/이미지 어노테이션 작업에 사용됩니다.

## 주요 변경사항 (원본 대비)

- **MinIO 글로벌 스토리지** — 프로젝트별 Cloud Storage 연결 없이 파일 업로드 시 자동으로 MinIO에 저장
- **Presigned URL 직접 업로드** — 이미지/비디오/오디오 파일은 Django를 거치지 않고 MinIO에 직접 업로드 (전송 속도 2배)
- **청크 업로드** — 80MB 단위 multipart upload로 Cloudflare Tunnels 100MB 제한 우회, 10GB+ 파일 지원
- **업로드 진행률 UI** — 파일별 프로그레스 바 + 퍼센트 표시
- **Storage Browser** — 프로젝트 Settings에서 파일 목록 확인, 다운로드, 삭제 (연관 Task 함께 삭제)
- **초대 권한 제한** — superuser만 멤버 초대 가능 (일반 유저는 버튼 숨김 + API 403)
- **자유 가입 차단** — 초대 링크 없이는 가입 불가 (`DISABLE_SIGNUP_WITHOUT_LINK`)
- **Cloud Storage UI 제거** — Settings 메뉴, Import 페이지에서 Cloud Storage 관련 UI 제거

## 아키텍처

```
Browser
  │
  ├── HTTPS ──→ Cloudflare Tunnel ──→ nginx(:8090)
  │                                      │
  │              ┌───────────────────────┤
  │              │                       │
  │         /data/*              /minio-upload/*          /*
  │              │                       │                │
  │              ▼                       ▼                ▼
  │         MinIO(:9000)           MinIO(:9000)     Backend(:8080)
  │         (파일 서빙)         (presigned 업로드)   (Django + 프론트엔드)
  │
  └── 파일 업로드 흐름:
       작은 파일(<80MB): presigned PUT 1회 → MinIO 직접
       큰 파일(>80MB):  80MB 청크 분할 → multipart upload → MinIO 직접
```

### 서비스 구성

| 서비스 | 이미지 | 포트 (호스트) | 설명 |
|--------|--------|--------------|------|
| nginx | nginx:alpine | **8090** | 리버스 프록시 (유일한 외부 진입점) |
| backend | label-studio-dev | 내부만 | Django + 빌드된 프론트엔드 |
| minio | minio/minio | **9009** (Console만) | S3 호환 오브젝트 스토리지 |
| minio-init | minio/mc | - | 버킷 자동 생성 (one-shot) |

### 데이터 저장

| 볼륨 | 내용 |
|------|------|
| `ls-dev-data` | SQLite DB, Django 설정 |
| `minio-data` | 업로드된 파일 (이미지, 비디오, 오디오 등) |

## 실행 방법

### 1. Docker 이미지 빌드

```bash
docker build -t label-studio-dev:latest .
```

### 2. 서비스 시작

```bash
docker compose -f docker-compose.dev.yml up -d
```

최초 실행 시:
- MinIO 버킷 `label-studio` 자동 생성
- admin 계정 자동 생성 (docker-compose.dev.yml의 `USERNAME`/`PASSWORD`)

### 3. 접속

- **웹 UI**: http://localhost:8090
- **MinIO Console**: http://localhost:9009 (ID: `minioadmin`)

### 4. 서비스 중지

```bash
docker compose -f docker-compose.dev.yml down
```

데이터(볼륨) 포함 완전 초기화:

```bash
docker compose -f docker-compose.dev.yml down -v
```

## Cloudflare Tunnel 연동

### 설치 및 설정

```bash
# cloudflared 설치
curl -sL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /tmp/cloudflared
chmod +x /tmp/cloudflared

# 로그인 (브라우저 인증 필요)
/tmp/cloudflared tunnel login

# 터널 생성
/tmp/cloudflared tunnel create label-studio

# DNS 라우팅
/tmp/cloudflared tunnel route dns label-studio <subdomain>.<domain>
```

### config.yml 예시

```yaml
tunnel: <tunnel-id>
credentials-file: ~/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: <subdomain>.<domain>
    service: http://localhost:8090
    originRequest:
      connectTimeout: 120s
      noTLSVerify: true
      tcpKeepAlive: 120s
      keepAliveTimeout: 600s
      disableChunkedEncoding: true
  - service: http_status:404
```

### 실행

```bash
/tmp/cloudflared tunnel run label-studio
```

### CSRF 설정

`docker-compose.dev.yml`의 `CSRF_TRUSTED_ORIGINS`에 Cloudflare 도메인 추가 필요:

```yaml
- CSRF_TRUSTED_ORIGINS=http://localhost:8090,https://<subdomain>.<domain>
```

## 계정 관리

### 기본 admin 계정

`docker-compose.dev.yml`에서 설정:

```yaml
- USERNAME=${LS_USERNAME:-testuser@cryptolab.co.kr}
- PASSWORD=${LS_PASSWORD:-Cryptolab1!}
```

### 추가 유저 생성

```bash
docker exec label-studio-backend-1 python3 label_studio/manage.py shell -c "
from users.models import User
from organizations.models import Organization
org = Organization.objects.first()
u = User.objects.create_user(email='user@example.com', password='password')
org.add_user(u)
u.active_organization = org
u.save(update_fields=['active_organization'])
"
```

### 가입 정책

- `DISABLE_SIGNUP_WITHOUT_LINK=true` — 초대 링크 없이 가입 불가
- 초대 링크 생성은 superuser만 가능 (Organization 페이지)

## 프론트엔드 개발 모드

프론트엔드만 로컬에서 HMR로 개발하려면:

```bash
# 백엔드 + MinIO는 Docker로
docker compose -f docker-compose.dev.yml up -d

# 프론트엔드 dev 서버 (별도 터미널)
cd web
yarn install
DJANGO_HOSTNAME=http://localhost:8085 yarn dev --host 0.0.0.0
```

이 경우 `deploy/dev/nginx.conf`에 frontend upstream 추가 및 `/react-app/` 프록시 설정이 필요합니다.

## 환경 변수 참조

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `USERNAME` | `testuser@cryptolab.co.kr` | 초기 admin 이메일 |
| `PASSWORD` | `Cryptolab1!` | 초기 admin 비밀번호 |
| `DISABLE_SIGNUP_WITHOUT_LINK` | `true` | 초대 링크 없이 가입 차단 |
| `CSRF_TRUSTED_ORIGINS` | - | 허용할 origin 목록 (쉼표 구분) |
| `MINIO_STORAGE_ENDPOINT` | `http://minio:9000` | MinIO 내부 엔드포인트 |
| `MINIO_STORAGE_BUCKET_NAME` | `label-studio` | MinIO 버킷 이름 |
| `MINIO_STORAGE_ACCESS_KEY` | `minioadmin` | MinIO 접근 키 |
| `MINIO_STORAGE_SECRET_KEY` | `minioadmin` | MinIO 비밀 키 |
| `MINIO_RELATIVE_URL_PREFIX` | `/data` | 파일 URL prefix (상대 경로) |
| `MINIO_PROXY_PREFIX` | `/minio-upload` | presigned URL nginx 프록시 경로 |
| `DATA_UPLOAD_MAX_MEMORY_SIZE` | `11811160064` | 최대 업로드 크기 (~11GB) |
