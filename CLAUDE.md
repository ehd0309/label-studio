# Label Studio (Custom Fork) — 작업 가이드

이 문서는 본 저장소에서 작업하는 모든 사람(사람/AI 에이전트 포함)이 따라야 할 워크플로우와 운영 환경 정보입니다.

## 1. 운영/개발 환경

| 환경 | 위치 | URL | 용도 |
|------|------|-----|------|
| **운영** | GCP `asia-northeast3-a` | https://ls.3pools.org | 실 사용자 라벨링 작업 |
| **개발** | 온프레미스 `192.168.50.3` | http://localhost:8090 | 코드/기능 검증 |
| **저장소** | GCS 버킷 `ls-data-cryptolab-2026` | — | 운영 미디어 파일 |
| **저장소 (개발)** | MinIO (Docker volume) | — | 개발용 미디어 |

## 2. 브랜치 전략

```
feature/xxx ──PR──> develop ──PR──> main
                   (개발 검증)    (운영 배포)
```

### 절대 금지
- ❌ **`main` 브랜치 직접 push 금지**
- ❌ `develop` 브랜치 직접 push 금지 (가능하면 PR 사용)
- ❌ `--force`, `--no-verify` 옵션 사용 금지 (사용자가 명시적으로 요청한 경우 제외)

### 표준 흐름
1. `develop`에서 새 브랜치 생성: `git checkout -b feat/xxx`
2. 작업 후 `feat/xxx`에 commit & push
3. **GitHub에서 `feat/xxx` → `develop` PR 생성**
4. 리뷰/검증 후 머지
5. 운영 배포 시점에 `develop` → `main` PR 생성 후 머지
6. main 머지 시 자동으로 GCP 운영 배포 (CI/CD)

### 브랜치 네이밍
- `feat/<짧은-설명>` — 새 기능
- `fix/<짧은-설명>` — 버그 수정
- `chore/<짧은-설명>` — 잡일 (의존성 등)
- `docs/<짧은-설명>` — 문서

## 3. 커밋 메시지

Conventional Commits 형식 권장:
```
<type>: <summary>

<body, 필요 시>
```

타입: `feat`, `fix`, `chore`, `docs`, `refactor`, `perf`, `test`, `ci`

## 4. 배포 절차

### 자동 배포 (권장)
- `main` 브랜치에 머지 → GitHub Actions가 자동으로 GCP 배포

### 수동 배포 (긴급/예외)
```bash
# 1. 프론트엔드 빌드
cd web && rm -rf .nx/cache dist/apps/labelstudio && NODE_ENV=production npx yarn run build

# 2. Docker 이미지 빌드 (Dockerfile.patch 사용 — 빠름)
DOCKER_BUILDKIT=1 docker build -t label-studio-dev:latest -t label-studio-dev:$(date +%Y%m%d-%H%M) -f Dockerfile.patch .

# 3. 이미지 저장 + 전송
docker save label-studio-dev:latest | gzip > /tmp/ls-image.tar.gz
gcloud compute scp /tmp/ls-image.tar.gz label-studio:/home/pds0309/label-studio/ --zone=asia-northeast3-a

# 4. GCP에서 배포
gcloud compute ssh label-studio --zone=asia-northeast3-a --command="
  cd /home/pds0309/label-studio
  sudo docker load < ls-image.tar.gz && rm ls-image.tar.gz
  sudo docker compose up -d --force-recreate backend
"
```

### 배포 전 체크리스트
- [ ] 진행 중인 ffmpeg 변환 작업 없는지 확인 (`docker exec label-studio-backend-1 ps aux | grep ffmpeg`)
- [ ] 사용자 활동 없는 시간대인지 확인 (백엔드 로그 마지막 활동 시각)
- [ ] 디스크 여유 충분한지 (`df -h /`)

## 5. 핵심 환경 변수 (운영)

| 변수 | 값 | 비고 |
|------|------|------|
| `MINIO_STORAGE_ENDPOINT` | `https://storage.googleapis.com` | GCS S3 호환 API |
| `MINIO_STORAGE_BUCKET_NAME` | `ls-data-cryptolab-2026` | GCS 버킷 |
| `MINIO_RELATIVE_URL_PREFIX` | `/data` | 상대 URL prefix |
| `GOOGLE_APPLICATION_CREDENTIALS` | `/label-studio/gcs-sa-key.json` | GCS 네이티브 API용 |
| `CSRF_TRUSTED_ORIGINS` | `https://ls.3pools.org` | 운영 도메인 |
| `DISABLE_SIGNUP_WITHOUT_LINK` | `true` | 초대 링크 필수 |

## 6. 주요 컴포넌트 위치

| 영역 | 경로 |
|------|------|
| Storage Browser | `web/apps/labelstudio/src/pages/Settings/StorageBrowser.jsx` |
| 파일 업로드/변환 API | `label_studio/data_import/api.py` |
| WMV→MP4 변환 로직 | `label_studio/data_import/conversion.py` |
| 비디오 타임라인 minimap | `web/libs/editor/src/components/Timeline/Views/Frames/Minimap.tsx` |
| nginx 설정 (운영) | `deploy/dev/nginx.conf` (GCP에서는 `/home/pds0309/label-studio/deploy-dev/nginx.conf`) |
| docker-compose | `docker-compose.dev.yml` |
| Dockerfile (full) | `Dockerfile` |
| Dockerfile (patch, 빠른 빌드) | `Dockerfile.patch` |

## 7. 자주 쓰는 명령

```bash
# 운영 SSH
gcloud compute ssh label-studio --zone=asia-northeast3-a

# 백엔드 로그 (최근 활동 확인)
gcloud compute ssh label-studio --zone=asia-northeast3-a --command="
  cd /home/pds0309/label-studio && sudo docker compose logs backend --tail=30
"

# ffmpeg 진행 상황
gcloud compute ssh label-studio --zone=asia-northeast3-a --command="
  sudo docker exec label-studio-backend-1 ps aux | grep ffmpeg | grep -v grep
"

# GCS 파일 목록
gcloud storage ls -l gs://ls-data-cryptolab-2026/upload/

# 개발 환경 시작
docker compose -f docker-compose.dev.yml up -d
```

## 8. 작업 시 주의사항

### 배포 시
- **배포는 backend 컨테이너 재생성** — 진행 중인 ffmpeg 변환이 있으면 중단됨
- 사용자가 라벨링 중인지 백엔드 로그로 먼저 확인
- 운영 배포는 사용자가 적은 시간대(주로 한국 시간 새벽~오전)가 안전

### 코드 수정 시
- 백엔드 모델 변경 시 마이그레이션 고려
- 프론트엔드 빌드는 캐시 때문에 `rm -rf .nx/cache dist/apps/labelstudio` 후 빌드 필수
- minified JS에서 함수명 검색이 안 되니 API 엔드포인트 문자열로 검색

### 데이터 처리
- WMV 자동 변환은 백그라운드 스레드로 동작 (서버 재시작 시 진행 중인 작업 손실)
- 5MB 청크 multipart 업로드 사용 (Cloudflare Tunnel 시절 호환성 유지)
- presigned URL 만료 12시간

## 9. 트러블슈팅

| 증상 | 원인/해결 |
|------|----------|
| 502 응답 | 백엔드 부팅 중 (재시작 후 ~20초 대기) |
| `SignatureDoesNotMatch` | S3 V4 서명 누락 — `Config(signature_version='s3v4')` 확인 |
| 파일 업로드 후 404 | FileUpload 레코드는 있지만 GCS에 파일 없음 — multipart 실패 가능 |
| 변환 실패 | `convert-wmv-status` API로 에러 메시지 확인 |
| Storage Browser 빈 목록 | FileUpload-Task 연결 끊김 — `file_upload_id` 확인 |

## 10. 릴리즈

- `v1.x.x` 태그 형식 사용 (Semantic Versioning)
- 릴리즈 노트는 GitHub Releases에 작성 (한국어)
- 운영 배포 후 태그 생성 권장
