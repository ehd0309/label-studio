import logging
import os
import subprocess
import tempfile
import threading
import uuid

from django.conf import settings

logger = logging.getLogger(__name__)

# In-memory job tracker {job_id: {status, error, result, file_upload_id}}
_conversion_jobs = {}
_conversion_lock = threading.Lock()


def get_job_status(job_id):
    return _conversion_jobs.get(job_id)


def is_converting(file_upload_id):
    """Check if a conversion is already in progress for this file."""
    with _conversion_lock:
        for job in _conversion_jobs.values():
            if job.get('file_upload_id') == file_upload_id and job['status'] in ('pending', 'converting'):
                return True
    return False


def start_conversion(file_upload_id, project_id, user_id, delete_original=True):
    """Start async WMV to MP4 conversion. Returns job_id."""
    if is_converting(file_upload_id):
        raise ValueError('Conversion already in progress for this file')

    job_id = uuid.uuid4().hex[:12]
    _conversion_jobs[job_id] = {
        'status': 'pending',
        'file_upload_id': file_upload_id,
        'error': None,
        'result': None,
    }

    t = threading.Thread(
        target=_do_convert,
        args=(job_id, file_upload_id, project_id, user_id, delete_original),
        daemon=True,
    )
    t.start()
    return job_id


def _get_gcs_bucket():
    """Get GCS bucket using native API (works for large file upload/download)."""
    from google.cloud import storage as gcs_storage

    bucket_name = settings.AWS_STORAGE_BUCKET_NAME
    key_path = os.environ.get('GOOGLE_APPLICATION_CREDENTIALS', '/label-studio/gcs-sa-key.json')

    if os.path.exists(key_path):
        client = gcs_storage.Client.from_service_account_json(key_path)
    else:
        client = gcs_storage.Client()

    return client.bucket(bucket_name)


def _get_s3():
    """S3 client for operations that work with S3 compatible API."""
    import boto3
    from botocore.config import Config
    return boto3.client(
        's3',
        endpoint_url=settings.AWS_S3_ENDPOINT_URL,
        aws_access_key_id=settings.AWS_ACCESS_KEY_ID,
        aws_secret_access_key=settings.AWS_SECRET_ACCESS_KEY,
        config=Config(signature_version='s3v4'),
    )


def _do_convert(job_id, file_upload_id, project_id, user_id, delete_original):
    from data_import.models import FileUpload
    from tasks.models import Task

    _conversion_jobs[job_id]['status'] = 'converting'
    tmp_input = None
    tmp_output = None

    try:
        fu = FileUpload.objects.get(id=file_upload_id, project_id=project_id)
        wmv_key = fu.file.name
        mp4_key = os.path.splitext(wmv_key)[0] + '.mp4'
        bucket_name = settings.AWS_STORAGE_BUCKET_NAME

        # Download WMV using GCS native API (resumable, no signature issues)
        tmp_input = tempfile.NamedTemporaryFile(suffix='.wmv', delete=False)
        tmp_input.close()
        try:
            bucket = _get_gcs_bucket()
            blob = bucket.blob(wmv_key)
            blob.download_to_filename(tmp_input.name)
            logger.info(f'Downloaded {wmv_key} via GCS native API')
        except Exception as e:
            logger.warning(f'GCS native download failed ({e}), falling back to S3 API')
            s3 = _get_s3()
            s3.download_file(bucket_name, wmv_key, tmp_input.name)

        tmp_output = tempfile.NamedTemporaryFile(suffix='.mp4', delete=False)
        tmp_output.close()

        # Try codec copy first (fast, lossless)
        result = subprocess.run(
            ['ffmpeg', '-y', '-i', tmp_input.name, '-c', 'copy', tmp_output.name],
            capture_output=True, text=True, timeout=3600,
        )

        # Check if output is valid (non-zero size)
        if result.returncode != 0 or os.path.getsize(tmp_output.name) < 1024:
            logger.info(f'Codec copy failed for {wmv_key}, falling back to re-encode')
            result = subprocess.run(
                ['ffmpeg', '-y', '-i', tmp_input.name, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-c:a', 'aac', tmp_output.name],
                capture_output=True, text=True, timeout=72000,
            )
            if result.returncode != 0:
                raise RuntimeError(f'ffmpeg failed: {result.stderr[:500]}')

        # Upload MP4 using GCS native API (resumable, handles large files)
        try:
            bucket = _get_gcs_bucket()
            blob = bucket.blob(mp4_key)
            blob.upload_from_filename(tmp_output.name)
            logger.info(f'Uploaded {mp4_key} via GCS native API')
        except Exception as e:
            logger.warning(f'GCS native upload failed ({e}), falling back to S3 API')
            s3 = _get_s3()
            s3.upload_file(tmp_output.name, bucket_name, mp4_key)

        # Update FileUpload record
        fu.file.name = mp4_key
        fu.save(update_fields=['file'])

        # Create or update Task
        from projects.models import Project
        project = Project.objects.get(id=project_id)
        new_url = getattr(settings, 'MINIO_RELATIVE_URL_PREFIX', '/data') + '/' + mp4_key

        existing_tasks = Task.objects.filter(file_upload=fu)
        if existing_tasks.exists():
            for task in existing_tasks:
                old_url = getattr(settings, 'MINIO_RELATIVE_URL_PREFIX', '/data') + '/' + wmv_key
                updated = False
                for key, val in task.data.items():
                    if isinstance(val, str) and val == old_url:
                        task.data[key] = new_url
                        updated = True
                if updated:
                    task.save(update_fields=['data'])
        else:
            task = Task.objects.create(
                project=project,
                data={settings.DATA_UNDEFINED_NAME: mp4_key if settings.CLOUD_FILE_STORAGE_ENABLED else new_url},
                file_upload=fu,
            )
            project.update_tasks_counters_and_task_states(
                tasks_queryset=Task.objects.filter(id=task.id),
                maximum_annotations_changed=False,
                overlap_cohort_percentage_changed=False,
                tasks_number_changed=True,
            )

        # Delete original WMV
        if delete_original:
            try:
                bucket = _get_gcs_bucket()
                bucket.blob(wmv_key).delete()
            except Exception:
                s3 = _get_s3()
                s3.delete_object(Bucket=bucket_name, Key=wmv_key)

        _conversion_jobs[job_id]['status'] = 'completed'
        _conversion_jobs[job_id]['result'] = {
            'mp4_key': mp4_key,
            'file_upload_id': file_upload_id,
        }
        logger.info(f'Conversion completed: {wmv_key} -> {mp4_key}')

    except Exception as e:
        logger.error(f'Conversion failed for job {job_id}: {e}')
        _conversion_jobs[job_id]['status'] = 'failed'
        _conversion_jobs[job_id]['error'] = str(e)
    finally:
        if tmp_input and os.path.exists(tmp_input.name):
            os.unlink(tmp_input.name)
        if tmp_output and os.path.exists(tmp_output.name):
            os.unlink(tmp_output.name)
