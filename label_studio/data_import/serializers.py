"""This file and its contents are licensed under the Apache License 2.0. Please see the included NOTICE for copyright information and LICENSE for a copy of the license."""

from rest_framework import serializers
from tasks.models import Task
from tasks.serializers import AnnotationSerializer, PredictionSerializer, TaskSerializer, TaskSerializerBulk

from .models import FileUpload


class ImportApiSerializer(TaskSerializer):
    """Tasks serializer for Import API (TaskBulkCreateAPI)"""

    annotations = AnnotationSerializer(many=True, default=[])
    predictions = PredictionSerializer(many=True, default=[])

    class Meta:
        model = Task
        list_serializer_class = TaskSerializerBulk
        exclude = ('is_labeled', 'project')


class FileUploadSerializer(serializers.ModelSerializer):
    file = serializers.FileField(use_url=False)
    size = serializers.SerializerMethodField()

    class Meta:
        model = FileUpload
        fields = ['id', 'file', 'size']

    def get_size(self, obj) -> int | None:
        try:
            return obj.file.size
        except (ValueError, OSError):
            return None


class FileUploadBrowserSerializer(serializers.ModelSerializer):
    file = serializers.FileField(use_url=False)
    size = serializers.SerializerMethodField()
    url = serializers.SerializerMethodField()
    name = serializers.SerializerMethodField()
    created_at = serializers.SerializerMethodField()

    class Meta:
        model = FileUpload
        fields = ['id', 'file', 'name', 'display_name', 'size', 'url', 'created_at']

    def get_size(self, obj) -> int | None:
        # Prefer the size recorded at upload time; fall back to a storage stat.
        if obj.size is not None:
            return obj.size
        try:
            return obj.file.size
        except (ValueError, OSError):
            return None

    def get_url(self, obj) -> str:
        return obj.url

    def get_name(self, obj) -> str:
        # Show the user-facing name (renamed display_name, else cleaned basename).
        return obj.display_filename

    def get_created_at(self, obj) -> str | None:
        from tasks.models import Task
        task = Task.objects.filter(file_upload=obj).first()
        if task and task.created_at:
            return task.created_at.isoformat()
        return None
