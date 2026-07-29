from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('data_import', '0002_alter_fileupload_file'),
    ]

    operations = [
        migrations.AddField(
            model_name='fileupload',
            name='display_name',
            field=models.CharField(blank=True, max_length=1024, null=True),
        ),
        migrations.AddField(
            model_name='fileupload',
            name='size',
            field=models.BigIntegerField(blank=True, null=True),
        ),
    ]
